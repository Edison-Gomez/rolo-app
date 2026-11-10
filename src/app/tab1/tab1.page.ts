import { AfterViewInit, Component, ViewChild, computed, effect, signal } from '@angular/core';
import { ActionSheetController, AlertController, IonModal, ToastController } from '@ionic/angular/lazy';
import { Geolocation } from '@capacitor/geolocation';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import * as L from 'leaflet';
// Agrupa los pines cercanos en burbujas cuando se aleja el mapa.
import 'leaflet.markercluster';
import { Categoria, Coordenada, MAX_FOTOS, Punto, PuntosService } from '../puntos.service';
import { AlertasService, TipoRecordatorio } from '../alertas.service';

// Fix necesario: con el bundler de Angular, Leaflet no encuentra solo los
// íconos por defecto del marcador. Se apuntan a mano a los que copiamos
// a /leaflet (ver angular.json).
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'leaflet/marker-icon-2x.png',
  iconUrl: 'leaflet/marker-icon.png',
  shadowUrl: 'leaflet/marker-shadow.png',
});

// Datos del punto que se está creando o editando.
interface Borrador extends Coordenada {
  id: number | null; // null = punto nuevo
  nombre: string;
  nota: string;
  categoria: Categoria;
  direccion: string;
  buscandoDireccion: boolean;
  fotos: string[];
  // Precisión del GPS en metros; null si el punto se eligió a mano en el mapa.
  precision: number | null;
}

type Modo = 'ver' | 'ubicar' | 'formulario' | 'navegando';

// Formas de llegar a un punto.
type Transporte = 'pie' | 'bici' | 'carro';

interface Ruta {
  metros: number;
  segundos: number;
  coordenadas: L.LatLng[];
  pasos: Paso[];
}

// Una indicación de la ruta ("Gira a la derecha en la Calle 12").
interface Paso {
  texto: string;
  // Grados para rotar la flecha: 0 = derecho, -90 = izquierda, 90 = derecha.
  giro: number;
  vuelta: boolean; // vuelta en U
  glorieta: boolean;
  // Posición de la maniobra dentro de las coordenadas de la ruta.
  indice: number;
}

// Estado de la navegación paso a paso.
interface Navegacion {
  destino: { id: number; titulo: string; lat: number; lng: number };
  transporte: Transporte;
  ruta: Ruta;
  // Hasta qué punto de la ruta ya se avanzó.
  indice: number;
  pasoActual: number;
  metrosAlPaso: number;
  metrosRestantes: number;
  segundosRestantes: number;
}

const RADIO_LLEGADA = 30; // metros
const DESVIO_MAXIMO = 45; // metros fuera de la ruta antes de recalcular

const TRANSPORTES: { id: Transporte; nombre: string; icono: string; perfil: string; estilo: L.PolylineOptions }[] = [
  { id: 'pie', nombre: 'A pie', icono: 'walk-outline', perfil: 'routed-foot', estilo: { color: '#1d4ed8', weight: 5, dashArray: '1 9', lineCap: 'round' } },
  { id: 'bici', nombre: 'Bici', icono: 'bicycle-outline', perfil: 'routed-bike', estilo: { color: '#1a7f4b', weight: 5 } },
  { id: 'carro', nombre: 'Carro o moto', icono: 'car-sport-outline', perfil: 'routed-car', estilo: { color: '#1d4ed8', weight: 6 } },
];

const BOGOTA: Coordenada = { lat: 4.60971, lng: -74.08175 };

@Component({
  selector: 'app-tab1',
  templateUrl: 'tab1.page.html',
  styleUrls: ['tab1.page.scss'],
  standalone: false,
})
export class Tab1Page implements AfterViewInit {
  readonly maxFotos = MAX_FOTOS;

  // Estado de la pantalla (signals: la vista se actualiza sola al cambiarlos).
  modo = signal<Modo>('ver');
  idSeleccionado = signal<number | null>(null);
  borrador = signal<Borrador | null>(null);
  readonly transportes = TRANSPORTES;
  // Rutas calculadas hacia el punto abierto, una por forma de llegar.
  rutas = signal<Partial<Record<Transporte, Ruta>> | null>(null);
  transporte = signal<Transporte>('pie');
  cargandoRuta = signal(false);
  // Tarjeta de "Estás aquí" al tocar el punto azul.
  tarjetaYo = signal(false);
  direccionYo = signal('');

  @ViewChild('modalPrevia') modalPrevia?: IonModal;

  // Navegación paso a paso ("Iniciar"), como en las apps de mapas.
  navegacion = signal<Navegacion | null>(null);
  seguirUsuario = signal(true);
  recalculando = signal(false);
  private ultimoRecalculo = 0;

  // Datos listos para pintar la barra de navegación.
  guia = computed(() => {
    const nav = this.navegacion();
    if (!nav) {
      return null;
    }
    const paso = nav.ruta.pasos[nav.pasoActual];
    const siguiente = nav.ruta.pasos[nav.pasoActual + 1];
    const llegada = new Date(Date.now() + nav.segundosRestantes * 1000);
    return {
      paso,
      siguiente,
      distanciaPaso: this.formatoCorto(nav.metrosAlPaso),
      restante: this.datos.formatoDistancia(nav.metrosRestantes),
      tiempo: this.formatoDuracion(Math.max(1, Math.round(nav.segundosRestantes / 60))),
      llegada: llegada.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' }),
      destino: nav.destino.titulo,
      icono: TRANSPORTES.find((t) => t.id === nav.transporte)!.icono,
    };
  });

  // Opciones de transporte con su tiempo, listas para mostrar.
  opcionesRuta = computed(() => {
    const rutas = this.rutas();
    if (!rutas) {
      return [];
    }
    return TRANSPORTES.map((t) => {
      const ruta = rutas[t.id];
      return {
        ...t,
        disponible: !!ruta,
        tiempo: ruta ? this.formatoDuracion(Math.max(1, Math.round(ruta.segundos / 60))) : '—',
        distancia: ruta ? this.datos.formatoDistancia(ruta.metros) : '',
      };
    });
  });

  // Resumen de la ruta elegida.
  resumenRuta = computed(() => this.opcionesRuta().find((o) => o.id === this.transporte()) ?? null);
  fotoVisible = signal(0);
  busqueda = signal('');
  // La ficha completa del punto está abierta (se llega con "Ver más").
  verMas = signal(false);

  // Resultados del buscador, listos para mostrar (máximo 6).
  resultados = computed(() =>
    this.datos
      .buscar(this.busqueda())
      .slice(0, 6)
      .map(({ punto }) => {
        const categoria = this.datos.categoria(punto.categoria);
        const titulo = this.datos.titulo(punto);
        return {
          id: punto.id,
          titulo,
          subtitulo:
            punto.nombre && punto.direccion
              ? `${categoria.nombre} · ${punto.direccion}`
              : titulo !== categoria.nombre
                ? categoria.nombre
                : punto.nota || this.datos.textoCoordenadas(punto),
          foto: punto.fotos[0] ?? null,
          icono: categoria.icono,
        };
      })
  );

  // Ids de los puntos que coinciden con la búsqueda; null si no se está buscando.
  private coincidencias = computed(() =>
    this.busqueda().trim() ? new Set(this.datos.buscar(this.busqueda()).map((r) => r.punto.id)) : null
  );

  // Texto listo para mostrar del punto abierto en el panel.
  detalle = computed(() => {
    const id = this.idSeleccionado();
    const punto = this.datos.puntos().find((p) => p.id === id);
    if (!punto) {
      return null;
    }
    const yo = this.datos.miUbicacion();
    const categoria = this.datos.categoria(punto.categoria);
    const fecha = new Date(punto.fecha);
    return {
      ...punto,
      titulo: this.datos.titulo(punto),
      categoriaNombre: categoria.nombre,
      categoriaIcono: categoria.icono,
      coordenadas: this.datos.textoCoordenadas(punto),
      distancia: yo ? this.datos.formatoDistancia(this.datos.distancia(yo, punto)) : null,
      fechaTexto: fecha.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }),
      horaTexto: fecha.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' }),
      destacado: punto.origen === 'destacado',
      comunidad: punto.origen === 'comunidad',
      editable: this.datos.sePuedeEditar(punto),
      yaConfirme: this.datos.yaConfirmado(punto),
      esReporte: punto.categoria === 'reporte',
      arregladoTexto: punto.resuelto
        ? new Date(punto.resuelto.fecha).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })
        : null,
    };
  });

  private map: L.Map | null = null;
  private marcadores = new Map<number, L.Marker>();
  private grupo: L.MarkerClusterGroup | null = null;
  private marcadorYo: L.Marker | null = null;
  private circuloPrecision: L.Circle | null = null;
  private pinBorrador: L.Marker | null = null;
  private lineaRuta: L.Polyline | null = null;

  constructor(
    public datos: PuntosService,
    public avisos: AlertasService,
    private alertas: AlertController,
    private opciones: ActionSheetController,
    private toasts: ToastController
  ) {
    // Cada vez que cambian los puntos o el seleccionado se repintan los pines.
    effect(() => {
      const puntos = this.datos.puntos();
      const seleccionado = this.idSeleccionado();
      this.coincidencias();
      this.sincronizarPines(puntos, seleccionado);
    });

    // La lista pidió abrir un punto en el mapa.
    effect(() => {
      const id = this.datos.puntoParaAbrir();
      if (id !== null && this.map) {
        this.datos.puntoParaAbrir.set(null);
        setTimeout(() => this.abrirPunto(id, true), 250);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.crearMapa();
    await this.datos.cargar();
    this.sincronizarPines(this.datos.puntos(), this.idSeleccionado());
    await this.ubicarme(true);
    this.seguirUbicacion();
  }

  // Sigue al usuario mientras camina: mueve el punto azul y revisa si hay
  // huecos o favoritos cerca para avisarle.
  private async seguirUbicacion(): Promise<void> {
    try {
      await Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 10000 }, (posicion) => {
        if (!posicion) {
          return;
        }
        const yo = {
          lat: posicion.coords.latitude,
          lng: posicion.coords.longitude,
          precision: Math.round(posicion.coords.accuracy ?? 0),
        };
        this.ponerMiUbicacion(yo);
        this.avisos.revisarCercania(yo);
        this.avanzarNavegacion(yo);
      });
    } catch (error) {
      console.error('No se pudo seguir la ubicación', error);
    }
  }

  // Al volver a esta pestaña el mapa debe recalcular su tamaño.
  ionViewDidEnter(): void {
    this.map?.invalidateSize();
    const id = this.datos.puntoParaAbrir();
    if (id !== null) {
      this.datos.puntoParaAbrir.set(null);
      setTimeout(() => this.abrirPunto(id, true), 250);
    }
  }

  // -------------------------------------------------------------------------
  // Mapa y ubicación
  // -------------------------------------------------------------------------

  private crearMapa(): void {
    const map = L.map('map', { zoomControl: false }).setView([BOGOTA.lat, BOGOTA.lng], 13);
    this.map = map;

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.attributionControl.setPrefix(false);

    // Los pines van dentro de un grupo que los junta en burbujas al alejar el
    // mapa; desde el zoom 16 se ven todos sueltos.
    // El plugin se instala sobre el objeto global L de Leaflet, no sobre el importado.
    const LGlobal = (window as any).L as typeof L;
    this.grupo = LGlobal.markerClusterGroup({
      maxClusterRadius: 55,
      disableClusteringAtZoom: 16,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      iconCreateFunction: (cluster) => this.iconoDeGrupo(cluster),
    }).addTo(map);

    // Mientras se ubica un punto, tocar el mapa mueve el pin.
    map.on('click', (evento: L.LeafletMouseEvent) => {
      if (this.modo() === 'ubicar') {
        this.moverBorrador(evento.latlng.lat, evento.latlng.lng, null);
      }
    });

    // La página puede seguir animando su entrada cuando se crea el mapa;
    // sin este ajuste a veces queda con el tamaño mal calculado.
    setTimeout(() => map.invalidateSize(), 150);
  }

  // Lee el GPS, pinta "mi ubicación" y opcionalmente centra el mapa ahí.
  async ubicarme(centrar: boolean): Promise<void> {
    if (!this.map) {
      return;
    }
    try {
      const posicion = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
      const yo = {
        lat: posicion.coords.latitude,
        lng: posicion.coords.longitude,
        precision: Math.round(posicion.coords.accuracy ?? 0),
      };
      this.ponerMiUbicacion(yo);

      if (centrar) {
        this.map.setView([yo.lat, yo.lng], 15);
      }
    } catch (error) {
      console.error('No se pudo obtener la ubicación', error);
      if (centrar && !this.datos.miUbicacion()) {
        this.avisar('No pudimos leer tu ubicación. Revisa el permiso de ubicación.');
      }
    }
  }

  // Pinta (o mueve) el punto azul de "mi ubicación".
  private ponerMiUbicacion(yo: Coordenada & { precision: number }): void {
    if (!this.map) {
      return;
    }
    this.datos.miUbicacion.set(yo);

    if (!this.marcadorYo) {
      // Punto azul con halo que late; el círculo claro muestra la precisión del GPS.
      this.circuloPrecision = L.circle([yo.lat, yo.lng], {
        radius: yo.precision,
        color: '#1d4ed8',
        weight: 1,
        opacity: 0.35,
        fillColor: '#1d4ed8',
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(this.map);
      this.marcadorYo = L.marker([yo.lat, yo.lng], {
        icon: L.divIcon({
          className: 'marcador-yo',
          html: '<span class="yo-halo"></span><span class="yo-punto"></span>',
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
        zIndexOffset: 300,
        keyboard: true,
        title: 'Tu ubicación',
      })
        .addTo(this.map)
        .on('click', () => this.abrirTarjetaYo());
    } else {
      this.marcadorYo.setLatLng([yo.lat, yo.lng]);
      this.circuloPrecision?.setLatLng([yo.lat, yo.lng]).setRadius(yo.precision);
    }
  }

  // Botón de ubicación: centra el mapa y muestra la tarjeta "Estás aquí".
  async irAMiUbicacion(): Promise<void> {
    await this.ubicarme(true);
    if (this.datos.miUbicacion()) {
      this.abrirTarjetaYo();
    }
  }

  private abrirTarjetaYo(): void {
    const yo = this.datos.miUbicacion();
    if (!yo || this.modo() !== 'ver') {
      return;
    }
    this.cerrarPunto();
    this.tarjetaYo.set(true);
    this.direccionYo.set('');
    this.datos.buscarDireccion(yo).then((direccion) => this.direccionYo.set(direccion));
  }

  cerrarTarjetaYo(): void {
    this.tarjetaYo.set(false);
  }

  // Atajo: crea un punto justo donde estás, sin pasar por el paso de ubicar el pin.
  agregarAqui(): void {
    const yo = this.datos.miUbicacion();
    if (!yo || !this.map) {
      return;
    }
    this.cerrarTarjetaYo();
    this.borrador.set({
      id: null,
      lat: yo.lat,
      lng: yo.lng,
      precision: yo.precision,
      nombre: '',
      nota: '',
      categoria: 'reporte',
      direccion: this.direccionYo(),
      buscandoDireccion: false,
      fotos: [],
    });
    this.ponerPinBorrador();
    this.continuarAlFormulario();
  }

  textoDireccionYo = computed(() => {
    const yo = this.datos.miUbicacion();
    return this.direccionYo() || (yo ? this.datos.textoCoordenadas(yo) : '');
  });

  // -------------------------------------------------------------------------
  // Pines de los puntos
  // -------------------------------------------------------------------------

  // Deja en el mapa exactamente un pin por punto guardado.
  private sincronizarPines(puntos: Punto[], seleccionado: number | null): void {
    if (!this.map) {
      return;
    }
    const vigentes = new Set(puntos.map((p) => p.id));
    this.marcadores.forEach((marcador, id) => {
      if (!vigentes.has(id)) {
        this.grupo?.removeLayer(marcador);
        this.marcadores.delete(id);
      }
    });

    const coincidencias = this.coincidencias();
    puntos.forEach((punto) => {
      // Mientras se busca, los pines que no coinciden se ven atenuados.
      const atenuado = !!coincidencias && !coincidencias.has(punto.id) && punto.id !== seleccionado;
      const icono = this.iconoDePunto(punto, punto.id === seleccionado, atenuado);
      const existente = this.marcadores.get(punto.id);
      if (existente) {
        existente.setLatLng([punto.lat, punto.lng]).setIcon(icono);
        existente.setZIndexOffset(punto.id === seleccionado ? 500 : 0);
        return;
      }
      const marcador = L.marker([punto.lat, punto.lng], { icon: icono, riseOnHover: true });
      (marcador.options as any).puntoId = punto.id;
      this.grupo?.addLayer(marcador);
      marcador.on('click', () => {
        if (this.modo() === 'ver') {
          this.abrirPunto(punto.id, false);
        }
      });
      this.marcadores.set(punto.id, marcador);
    });
    // Las burbujas muestran la foto de un lugar: se redibujan si cambió algo.
    this.grupo?.refreshClusters();
  }

  // Burbuja de un grupo de pines: la foto de uno de sus lugares y cuántos son.
  private iconoDeGrupo(cluster: L.MarkerCluster): L.DivIcon {
    const ids = cluster.getAllChildMarkers().map((m) => (m.options as any).puntoId as number);
    const puntos = this.datos.puntos().filter((p) => ids.includes(p.id));
    // Se prefiere un favorito o un destacado con foto para representar al grupo.
    const conFoto =
      puntos.find((p) => p.favorito && p.fotos.length) ??
      puntos.find((p) => p.origen === 'destacado' && p.fotos.length) ??
      puntos.find((p) => p.fotos.length);

    const grupo = document.createElement('div');
    grupo.className = 'grupo-lugares';
    const circulo = document.createElement('div');
    circulo.className = 'grupo-circulo';
    if (conFoto) {
      const img = document.createElement('img');
      img.src = conFoto.fotos[0];
      img.alt = '';
      circulo.appendChild(img);
    } else {
      const icono = document.createElement('ion-icon');
      icono.setAttribute('name', 'location');
      circulo.appendChild(icono);
    }
    const cuenta = document.createElement('span');
    cuenta.className = 'grupo-cuenta';
    cuenta.textContent = String(cluster.getChildCount());
    grupo.append(circulo, cuenta);

    return L.divIcon({
      html: grupo,
      className: 'grupo-lugares-contenedor',
      iconSize: [56, 56],
      iconAnchor: [28, 28],
    });
  }

  // Pin redondo con la foto en miniatura; si no hay foto, el ícono de la categoría.
  private iconoDePunto(punto: Punto, activo: boolean, atenuado: boolean): L.DivIcon {
    const pin = document.createElement('div');
    pin.className = 'pin-lugar';
    pin.classList.toggle('activo', activo);
    pin.classList.toggle('atenuado', atenuado);
    pin.classList.toggle('favorito', punto.favorito);
    pin.classList.toggle('arreglado', !!punto.resuelto);

    const circulo = document.createElement('div');
    circulo.className = 'pin-circulo';

    const icono = document.createElement('ion-icon');
    icono.setAttribute('name', this.datos.categoria(punto.categoria).icono);
    icono.setAttribute('aria-hidden', 'true');
    circulo.appendChild(icono);

    if (punto.fotos.length) {
      const img = document.createElement('img');
      img.src = punto.fotos[0];
      img.alt = '';
      // Si la foto no carga, queda a la vista el ícono de la categoría.
      img.onerror = () => img.remove();
      circulo.appendChild(img);
    }

    pin.appendChild(circulo);
    if (punto.resuelto) {
      const check = document.createElement('span');
      check.className = 'pin-check';
      check.textContent = '✓';
      pin.appendChild(check);
    }
    return L.divIcon({
      html: pin,
      className: 'pin-lugar-contenedor',
      iconSize: [48, 58],
      iconAnchor: [24, 58],
    });
  }

  // -------------------------------------------------------------------------
  // Panel de detalle de un punto
  // -------------------------------------------------------------------------

  alBuscar(evento: Event): void {
    this.busqueda.set((evento.target as HTMLInputElement).value);
  }

  limpiarBusqueda(): void {
    this.busqueda.set('');
  }

  // Se eligió un resultado del buscador: se cierra la búsqueda y se abre el punto.
  abrirResultado(id: number): void {
    this.limpiarBusqueda();
    (document.activeElement as HTMLElement | null)?.blur();
    this.abrirPunto(id, true);
  }

  private abrirPunto(id: number, acercar: boolean): void {
    const punto = this.datos.puntos().find((p) => p.id === id);
    if (!punto || !this.map) {
      return;
    }
    this.quitarRuta();
    this.cerrarTarjetaYo();
    this.fotoVisible.set(0);
    this.idSeleccionado.set(id);

    // El pin se deja un poco arriba del centro para que el panel no lo tape.
    const zoom = acercar ? Math.max(this.map.getZoom(), 16) : this.map.getZoom();
    const destino = this.map
      .project([punto.lat, punto.lng], zoom)
      .add([0, Math.round(window.innerHeight * 0.2)]);
    this.map.setView(this.map.unproject(destino, zoom), zoom);
    this.ubicarme(false);

    // Los puntos que aún no tienen dirección la consultan la primera vez.
    if (!punto.direccion) {
      this.datos.buscarDireccion(punto).then((direccion) => {
        if (direccion) {
          this.datos.actualizar(id, { direccion });
        }
      });
    }
  }

  cerrarPunto(): void {
    this.verMas.set(false);
    this.idSeleccionado.set(null);
    if (this.modo() === 'navegando') {
      return;
    }
    this.quitarRuta();
  }

  // Actualiza el contador "1 / 2" al deslizar las fotos.
  alDeslizarFotos(evento: Event): void {
    const tira = evento.target as HTMLElement;
    this.fotoVisible.set(Math.round(tira.scrollLeft / Math.max(1, tira.clientWidth)));
  }

  // -------------------------------------------------------------------------
  // Ficha completa del punto
  // -------------------------------------------------------------------------

  abrirFicha(): void {
    this.fotoVisible.set(0);
    this.verMas.set(true);
  }

  cerrarFicha(): void {
    this.verMas.set(false);
  }

  alternarFavorito(): void {
    const id = this.idSeleccionado();
    if (id !== null) {
      this.datos.alternarFavorito(id);
    }
  }

  // La ruta se ve en el mapa, así que primero se cierra la ficha.
  rutaDesdeFicha(): void {
    this.cerrarFicha();
    setTimeout(() => this.verRuta(), 300);
  }

  editarDesdeFicha(): void {
    const punto = this.detalle();
    if (punto && !punto.editable) {
      this.avisar('Este punto lo publicó otra persona: solo ella puede editarlo.');
      return;
    }
    this.cerrarFicha();
    setTimeout(() => this.editarPunto(), 300);
  }

  // Agrega una foto al punto abierto sin pasar por el formulario.
  async agregarFotoAlPunto(origen: 'camara' | 'galeria'): Promise<void> {
    const punto = this.detalle();
    if (!punto || punto.fotos.length >= MAX_FOTOS) {
      return;
    }
    const foto = await this.pedirFoto(origen);
    if (!foto) {
      return;
    }
    if (!(await this.datos.actualizar(punto.id, { fotos: [...punto.fotos, foto] }))) {
      this.avisar('No se pudo guardar: no queda espacio para más fotos.');
    }
  }

  async quitarFotoDelPunto(indice: number): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }
    const alerta = await this.alertas.create({
      header: 'Quitar foto',
      message: '¿Quieres quitar esta foto del punto?',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Quitar', role: 'destructive' },
      ],
    });
    await alerta.present();
    if ((await alerta.onDidDismiss()).role === 'destructive') {
      this.fotoVisible.set(0);
      await this.datos.actualizar(punto.id, { fotos: punto.fotos.filter((_, i) => i !== indice) });
    }
  }

  // Comparte el punto con otra app (WhatsApp, correo…) o, si el dispositivo
  // no lo permite, copia el enlace.
  async compartir(): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }
    const enlace = `https://www.google.com/maps?q=${punto.lat},${punto.lng}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: punto.titulo, text: punto.titulo, url: enlace });
        return;
      }
      await navigator.clipboard.writeText(`${punto.titulo}: ${enlace}`);
      this.avisar('Enlace copiado');
    } catch {
      // El usuario cerró el menú de compartir; no hay nada que hacer.
    }
  }

  async copiarCoordenadas(): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }
    try {
      await navigator.clipboard.writeText(punto.coordenadas);
      this.avisar('Coordenadas copiadas');
    } catch {
      this.avisar('No se pudieron copiar las coordenadas.');
    }
  }

  // -------------------------------------------------------------------------
  // Recordatorios (notificaciones locales)
  // -------------------------------------------------------------------------

  recordatorioActual = computed(() => {
    const id = this.idSeleccionado();
    const r = id === null ? null : this.avisos.recordatorios().find((x) => x.puntoId === id);
    return r
      ? {
          ...r,
          texto: this.textoCuando(r.fecha),
        }
      : null;
  });

  // Selector de fecha y hora del recordatorio (sin opciones fijas).
  selectorFecha = signal(false);
  fechaElegida = signal('');
  fechaMinima = signal('');

  // Texto de cuándo llegará, para mostrarlo mientras se elige.
  textoFechaElegida = computed(() => {
    const valor = this.fechaElegida();
    if (!valor) {
      return '';
    }
    const fecha = new Date(valor);
    const minutos = Math.round((fecha.getTime() - Date.now()) / 60000);
    if (minutos < 1) {
      return 'Elige una hora que todavía no haya pasado';
    }
    const cuando = this.textoCuando(fecha);
    return minutos < 60 ? `${cuando} · en ${minutos} min` : cuando;
  });

  fechaValida = computed(() => {
    const valor = this.fechaElegida();
    return !!valor && new Date(valor).getTime() > Date.now() + 30_000;
  });

  // Abre el selector: la fecha y la hora las elige el usuario, desde ya mismo.
  elegirRecordatorio(): void {
    const ahora = new Date();
    const actual = this.recordatorioActual();
    // Propuesta inicial: la del recordatorio que ya existe o dentro de 5 minutos.
    const propuesta = actual ? actual.fecha : new Date(ahora.getTime() + 5 * 60_000);
    this.fechaMinima.set(this.isoLocal(ahora));
    this.fechaElegida.set(this.isoLocal(propuesta));
    this.selectorFecha.set(true);
  }

  alCambiarFecha(evento: Event): void {
    const valor = (evento as CustomEvent).detail?.value;
    if (typeof valor === 'string') {
      this.fechaElegida.set(valor);
    }
  }

  async guardarFechaElegida(): Promise<void> {
    const punto = this.datos.puntos().find((p) => p.id === this.idSeleccionado());
    if (!punto) {
      return;
    }
    if (!this.fechaValida()) {
      this.avisar('Elige una fecha y hora que todavía no hayan pasado.');
      return;
    }
    this.selectorFecha.set(false);
    const tipo: TipoRecordatorio = punto.categoria === 'reporte' ? 'seguimiento' : 'visita';
    await this.recordarA(punto, new Date(this.fechaElegida()), tipo);
  }

  // "2026-10-20T23:45" en hora local, el formato que usa el selector.
  private isoLocal(fecha: Date): string {
    const local = new Date(fecha.getTime() - fecha.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  private textoCuando(fecha: Date): string {
    const hoy = new Date();
    const manana = new Date();
    manana.setDate(hoy.getDate() + 1);
    const hora = fecha.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
    if (fecha.toDateString() === hoy.toDateString()) {
      return `Hoy a las ${hora}`;
    }
    if (fecha.toDateString() === manana.toDateString()) {
      return `Mañana a las ${hora}`;
    }
    return `${fecha.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })} a las ${hora}`;
  }

  // -------------------------------------------------------------------------
  // Estado de los reportes: sin arreglar / arreglado
  // -------------------------------------------------------------------------

  // Pregunta por la foto del después y marca el reporte como arreglado.
  async marcarArreglado(): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }
    const hoja = await this.opciones.create({
      header: '¿Tienes una foto de cómo quedó?',
      subHeader: 'Así se ve el antes y el después del reporte.',
      buttons: [
        { text: 'Tomar foto del después', icon: 'camera-outline', data: 'camara' },
        { text: 'Elegir de la galería', icon: 'images-outline', data: 'galeria' },
        { text: 'Marcar sin foto', icon: 'checkmark-circle-outline', data: 'sin-foto' },
        { text: 'Cancelar', icon: 'close', role: 'cancel' },
      ],
    });
    await hoja.present();
    const { data, role } = await hoja.onDidDismiss();
    if (role === 'cancel' || role === 'backdrop' || !data) {
      return;
    }

    let foto: string | null = null;
    if (data !== 'sin-foto') {
      foto = await this.pedirFoto(data);
      if (!foto) {
        return;
      }
    }
    if (await this.datos.marcarArreglado(punto.id, foto)) {
      // Ya no hace falta el recordatorio de "revisar si lo arreglaron".
      const recordatorio = this.avisos.recordatorioDe(punto.id);
      if (recordatorio?.tipo === 'seguimiento') {
        await this.avisos.cancelar(recordatorio.id);
      }
      this.avisar('¡Listo! Reporte marcado como arreglado');
    } else {
      this.avisar('No se pudo guardar: no queda espacio para más fotos.');
    }
  }

  async agregarFotoDespues(origen: 'camara' | 'galeria'): Promise<void> {
    const punto = this.detalle();
    if (!punto?.resuelto) {
      return;
    }
    const foto = await this.pedirFoto(origen);
    if (foto) {
      await this.datos.actualizar(punto.id, { resuelto: { ...punto.resuelto, foto } });
    }
  }

  // "Yo también lo vi": el reporte de otra persona sigue ahí.
  async confirmarReporte(): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }
    if (!this.datos.enLinea()) {
      this.avisar('Necesitas internet para confirmar el reporte.');
      return;
    }
    if (await this.datos.confirmar(punto.id)) {
      this.avisar('Gracias: confirmaste que el daño sigue ahí');
    } else {
      this.avisar('No se pudo confirmar ahora. Intenta de nuevo en un momento.');
    }
  }

  async reabrirReporte(): Promise<void> {
    const punto = this.detalle();
    if (punto && (await this.datos.reabrir(punto.id))) {
      this.avisar('El reporte vuelve a estar sin arreglar');
    }
  }

  async cancelarRecordatorio(): Promise<void> {
    const r = this.recordatorioActual();
    if (r) {
      await this.avisos.cancelar(r.id);
      this.avisar('Recordatorio cancelado');
    }
  }

  private async recordarA(punto: Punto, fecha: Date, tipo: TipoRecordatorio): Promise<void> {
    if (await this.avisos.programarRecordatorio(punto, fecha, tipo)) {
      this.avisar(`Listo: ${this.textoCuando(fecha).replace(/^./, (l) => l.toLowerCase())} te avisamos`);
    } else {
      this.avisar('Activa las notificaciones de Rolo para poder recordarte.');
    }
  }

  private async pedirFoto(origen: 'camara' | 'galeria'): Promise<string | null> {
    try {
      const foto = await Camera.getPhoto({
        quality: 65,
        width: 900,
        resultType: CameraResultType.DataUrl,
        source: origen === 'camara' ? CameraSource.Camera : CameraSource.Photos,
      });
      return foto.dataUrl ?? null;
    } catch {
      // Cancelar la cámara o negar el permiso no es un error grave.
      return null;
    }
  }

  async eliminarPunto(): Promise<void> {
    const punto = this.detalle();
    if (!punto) {
      return;
    }

    // Los puntos de otras personas no se borran del servidor: solo se quitan de este mapa.
    const alerta = await this.alertas.create({
      header: punto.comunidad ? 'Quitar de tu mapa' : 'Eliminar punto',
      message: punto.comunidad
        ? `"${punto.titulo}" lo publicó otra persona. Se quitará solo de tu mapa.`
        : `¿Seguro que quieres eliminar "${punto.titulo}"? No se puede deshacer.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: punto.comunidad ? 'Quitar' : 'Eliminar', role: 'destructive' },
      ],
    });
    await alerta.present();
    const { role } = await alerta.onDidDismiss();
    if (role !== 'destructive') {
      return;
    }

    this.cerrarPunto();
    await this.avisos.cancelarDePunto(punto.id);
    if (await this.datos.eliminar(punto.id)) {
      this.avisar(punto.comunidad ? 'Quitado de tu mapa' : 'Punto eliminado');
    }
  }

  // -------------------------------------------------------------------------
  // Cómo llegar: a pie, en bici o en carro/moto
  // -------------------------------------------------------------------------

  // Calcula las tres rutas a la vez (servidores públicos de OpenStreetMap)
  // y dibuja la que más conviene; después se puede cambiar.
  async verRuta(): Promise<void> {
    const punto = this.detalle();
    if (!punto || !this.map || this.cargandoRuta()) {
      return;
    }
    if (!this.datos.enLinea()) {
      this.avisar('Sin conexión no se puede calcular la ruta.');
      return;
    }

    this.cargandoRuta.set(true);
    try {
      await this.ubicarme(false);
      const yo = this.datos.miUbicacion();
      if (!yo) {
        this.avisar('Necesitamos tu ubicación para trazar la ruta.');
        return;
      }

      const resultados = await Promise.all(TRANSPORTES.map((t) => this.pedirRuta(t.perfil, yo, punto)));
      const rutas: Partial<Record<Transporte, Ruta>> = {};
      TRANSPORTES.forEach((t, i) => {
        const ruta = resultados[i];
        if (ruta) {
          rutas[t.id] = ruta;
        }
      });
      if (!Object.keys(rutas).length) {
        throw new Error('Sin rutas');
      }

      // Si caminando son 20 minutos o menos se sugiere a pie; si no, en carro o moto.
      const pie = rutas.pie;
      const sugerido: Transporte = pie && pie.segundos <= 20 * 60 ? 'pie' : rutas.carro ? 'carro' : (Object.keys(rutas)[0] as Transporte);
      this.rutas.set(rutas);
      this.elegirTransporte(sugerido);
      // La vista previa crece un poco para mostrar las opciones.
      this.modalPrevia?.setCurrentBreakpoint(0.62);
    } catch (error) {
      console.error('No se pudo trazar la ruta', error);
      this.avisar('No se pudo trazar la ruta. Revisa tu conexión.');
    } finally {
      this.cargandoRuta.set(false);
    }
  }

  elegirTransporte(id: Transporte): void {
    const ruta = this.rutas()?.[id];
    if (!ruta || !this.map) {
      return;
    }
    this.transporte.set(id);
    if (this.lineaRuta) {
      this.map.removeLayer(this.lineaRuta);
    }
    const estilo = TRANSPORTES.find((t) => t.id === id)!.estilo;
    this.lineaRuta = L.polyline(ruta.coordenadas, { ...estilo, opacity: 0.9 }).addTo(this.map);
    // Se deja espacio arriba y abajo para que nada tape la ruta.
    this.map.fitBounds(this.lineaRuta.getBounds(), {
      paddingTopLeft: [40, 130],
      paddingBottomRight: [40, Math.round(window.innerHeight * 0.55)],
    });
  }

  private async pedirRuta(perfil: string, desde: Coordenada, hasta: Coordenada): Promise<Ruta | null> {
    try {
      const url = `https://routing.openstreetmap.de/${perfil}/route/v1/driving/${desde.lng},${desde.lat};${hasta.lng},${hasta.lat}?overview=full&geometries=geojson&steps=true`;
      const datos = await (await fetch(url)).json();
      const ruta = datos.routes?.[0];
      if (!ruta) {
        return null;
      }
      const coordenadas: L.LatLng[] = ruta.geometry.coordinates.map((c: [number, number]) => L.latLng(c[1], c[0]));
      const pasos: Paso[] = (ruta.legs?.[0]?.steps ?? []).map((paso: any) => {
        const [lng, lat] = paso.maneuver.location;
        return {
          ...this.indicacion(paso),
          indice: this.indiceMasCercano(coordenadas, { lat, lng }, 0),
        };
      });
      return { metros: ruta.distance, segundos: ruta.duration, coordenadas, pasos };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Navegación paso a paso
  // -------------------------------------------------------------------------

  iniciarNavegacion(): void {
    const punto = this.detalle();
    const transporte = this.transporte();
    const ruta = this.rutas()?.[transporte];
    const yo = this.datos.miUbicacion();
    if (!punto || !ruta || !yo || !this.map) {
      return;
    }
    this.navegacion.set({
      destino: { id: punto.id, titulo: punto.titulo, lat: punto.lat, lng: punto.lng },
      transporte,
      ruta,
      indice: 0,
      pasoActual: 0,
      metrosAlPaso: 0,
      metrosRestantes: ruta.metros,
      segundosRestantes: ruta.segundos,
    });
    this.modo.set('navegando');
    this.seguirUsuario.set(true);
    // Se esconde la barra de pestañas para dejar todo el espacio al mapa.
    document.body.classList.add('rolo-navegando');
    this.cerrarPunto();
    this.cerrarTarjetaYo();
    this.avanzarNavegacion(yo);
    // Si el usuario mueve el mapa con el dedo, deja de seguirlo hasta que toque "Centrar".
    this.map.on('dragstart', this.alArrastrarMapa);
  }

  private alArrastrarMapa = () => {
    if (this.modo() === 'navegando') {
      this.seguirUsuario.set(false);
    }
  };

  centrarEnMi(): void {
    this.seguirUsuario.set(true);
    const yo = this.datos.miUbicacion();
    if (yo) {
      this.map?.setView([yo.lat, yo.lng], 17);
    }
  }

  async salirDeNavegacion(llegaste = false): Promise<void> {
    const nav = this.navegacion();
    this.navegacion.set(null);
    this.modo.set('ver');
    document.body.classList.remove('rolo-navegando');
    this.map?.off('dragstart', this.alArrastrarMapa);
    this.quitarRuta();
    if (llegaste && nav) {
      const alerta = await this.alertas.create({
        header: '¡Llegaste!',
        message: `Estás en ${nav.destino.titulo}.`,
        buttons: [
          { text: 'Ver el lugar', role: 'confirm' },
          { text: 'Listo', role: 'cancel' },
        ],
      });
      await alerta.present();
      if ((await alerta.onDidDismiss()).role === 'confirm') {
        this.abrirPunto(nav.destino.id, true);
      }
    }
  }

  // Cada vez que llega una nueva ubicación: avanza en la ruta, actualiza la
  // indicación, detecta la llegada y recalcula si el usuario se salió del camino.
  private avanzarNavegacion(yo: Coordenada): void {
    const nav = this.navegacion();
    if (!nav || !this.map) {
      return;
    }

    if (this.datos.distancia(yo, nav.destino) <= RADIO_LLEGADA) {
      this.salirDeNavegacion(true);
      return;
    }

    const coords = nav.ruta.coordenadas;
    // Se busca desde donde iba, para no "devolverse" en rutas que pasan cerca de sí mismas.
    const indice = this.indiceMasCercano(coords, yo, Math.max(0, nav.indice - 3));
    const desvio = this.datos.distancia(yo, coords[indice]);

    if (desvio > DESVIO_MAXIMO) {
      this.recalcularRuta(yo);
    }

    // Lo que falta: desde mí hasta el punto de la ruta y de ahí al final.
    let restantes = desvio;
    for (let i = indice; i < coords.length - 1; i++) {
      restantes += coords[i].distanceTo(coords[i + 1]);
    }
    let pasoActual = nav.ruta.pasos.findIndex((p, i) => i > 0 && p.indice > indice);
    if (pasoActual === -1) {
      pasoActual = nav.ruta.pasos.length - 1;
    }
    let alPaso = desvio;
    const hasta = nav.ruta.pasos[pasoActual]?.indice ?? coords.length - 1;
    for (let i = indice; i < hasta; i++) {
      alPaso += coords[i].distanceTo(coords[i + 1]);
    }

    this.navegacion.set({
      ...nav,
      indice,
      pasoActual,
      metrosAlPaso: alPaso,
      metrosRestantes: restantes,
      segundosRestantes: nav.ruta.segundos * (restantes / Math.max(1, nav.ruta.metros)),
    });

    // La línea muestra solo lo que falta por recorrer.
    const estilo = TRANSPORTES.find((t) => t.id === nav.transporte)!.estilo;
    const pendiente = [L.latLng(yo.lat, yo.lng), ...coords.slice(indice + 1)];
    if (this.lineaRuta) {
      this.lineaRuta.setLatLngs(pendiente);
    } else {
      this.lineaRuta = L.polyline(pendiente, { ...estilo, opacity: 0.9 }).addTo(this.map);
    }

    if (this.seguirUsuario()) {
      this.map.setView([yo.lat, yo.lng], Math.max(this.map.getZoom(), 17), { animate: true });
    }
  }

  private async recalcularRuta(yo: Coordenada): Promise<void> {
    const nav = this.navegacion();
    if (!nav || this.recalculando() || Date.now() - this.ultimoRecalculo < 12_000 || !this.datos.enLinea()) {
      return;
    }
    this.recalculando.set(true);
    this.ultimoRecalculo = Date.now();
    const perfil = TRANSPORTES.find((t) => t.id === nav.transporte)!.perfil;
    const ruta = await this.pedirRuta(perfil, yo, nav.destino);
    this.recalculando.set(false);
    const actual = this.navegacion();
    if (ruta && actual) {
      this.navegacion.set({ ...actual, ruta, indice: 0, pasoActual: 0 });
      this.avanzarNavegacion(yo);
    }
  }

  private indiceMasCercano(coords: L.LatLng[], punto: Coordenada, desde: number): number {
    let mejor = desde;
    let menor = Infinity;
    for (let i = desde; i < coords.length; i++) {
      const d = this.datos.distancia(punto, { lat: coords[i].lat, lng: coords[i].lng });
      if (d < menor) {
        menor = d;
        mejor = i;
      }
    }
    return mejor;
  }

  // Convierte una maniobra del servidor de rutas en una indicación en español.
  private indicacion(paso: any): Omit<Paso, 'indice'> {
    const tipo: string = paso.maneuver?.type ?? '';
    const modificador: string = paso.maneuver?.modifier ?? 'straight';
    const calle: string = paso.name || paso.ref || '';
    const giros: Record<string, { texto: string; giro: number }> = {
      left: { texto: 'Gira a la izquierda', giro: -90 },
      right: { texto: 'Gira a la derecha', giro: 90 },
      'slight left': { texto: 'Gira levemente a la izquierda', giro: -45 },
      'slight right': { texto: 'Gira levemente a la derecha', giro: 45 },
      'sharp left': { texto: 'Gira bruscamente a la izquierda', giro: -135 },
      'sharp right': { texto: 'Gira bruscamente a la derecha', giro: 135 },
      straight: { texto: 'Sigue derecho', giro: 0 },
      uturn: { texto: 'Da la vuelta en U', giro: 180 },
    };
    const g = giros[modificador] ?? giros['straight'];
    const por = calle ? ` por ${calle}` : '';

    switch (tipo) {
      case 'depart':
        return { texto: calle ? `Sal por ${calle}` : 'Comienza el recorrido', giro: 0, vuelta: false, glorieta: false };
      case 'arrive':
        return { texto: 'Llegas a tu destino', giro: 0, vuelta: false, glorieta: false };
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn': {
        const salida = paso.maneuver?.exit;
        return {
          texto: `En la glorieta, toma la ${salida ? `${salida}.ª salida` : 'salida'}${por}`,
          giro: g.giro,
          vuelta: false,
          glorieta: true,
        };
      }
      case 'merge':
        return { texto: `Incorpórate${por}`, giro: g.giro, vuelta: false, glorieta: false };
      case 'on ramp':
        return { texto: `Toma la entrada${por}`, giro: g.giro, vuelta: false, glorieta: false };
      case 'off ramp':
        return { texto: `Toma la salida${por}`, giro: g.giro, vuelta: false, glorieta: false };
      case 'fork':
        return {
          texto: `En la bifurcación, mantente a la ${g.giro < 0 ? 'izquierda' : 'derecha'}${por}`,
          giro: g.giro,
          vuelta: false,
          glorieta: false,
        };
      case 'new name':
      case 'continue':
        return { texto: `Continúa${por}`, giro: g.giro, vuelta: modificador === 'uturn', glorieta: false };
      default:
        return { texto: `${g.texto}${por}`, giro: g.giro, vuelta: modificador === 'uturn', glorieta: false };
    }
  }

  // "En 120 m", "En 1,3 km".
  private formatoCorto(metros: number): string {
    if (metros < 1000) {
      return `${Math.max(10, Math.round(metros / 10) * 10)} m`;
    }
    return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
  }

  private quitarRuta(): void {
    if (this.lineaRuta && this.map) {
      this.map.removeLayer(this.lineaRuta);
    }
    this.lineaRuta = null;
    this.rutas.set(null);
  }

  // -------------------------------------------------------------------------
  // Agregar o editar un punto: 1) ubicarlo en el mapa  2) llenar el formulario
  // -------------------------------------------------------------------------

  empezarAgregar(): void {
    if (!this.map) {
      return;
    }
    this.cerrarPunto();
    this.cerrarTarjetaYo();
    this.limpiarBusqueda();
    // El pin arranca donde estás; si no hay GPS, en el centro del mapa.
    const yo = this.datos.miUbicacion();
    const centro = this.map.getCenter();

    this.borrador.set({
      id: null,
      lat: yo?.lat ?? centro.lat,
      lng: yo?.lng ?? centro.lng,
      precision: yo ? yo.precision : null,
      nombre: '',
      nota: '',
      categoria: 'reporte',
      direccion: '',
      buscandoDireccion: false,
      fotos: [],
    });
    this.ponerPinBorrador();
    this.modo.set('ubicar');
  }

  // Abre el formulario con los datos del punto que se está viendo.
  editarPunto(): void {
    const punto = this.datos.puntos().find((p) => p.id === this.idSeleccionado());
    if (!punto) {
      return;
    }
    this.cerrarPunto();
    this.borrador.set({
      id: punto.id,
      lat: punto.lat,
      lng: punto.lng,
      precision: null,
      nombre: punto.nombre,
      nota: punto.nota,
      categoria: punto.categoria,
      direccion: punto.direccion,
      buscandoDireccion: false,
      fotos: [...punto.fotos],
    });
    this.ponerPinBorrador();
    // Se espera a que termine de bajar el panel antes de subir el formulario.
    setTimeout(() => this.continuarAlFormulario(), 300);
  }

  private ponerPinBorrador(): void {
    const borrador = this.borrador();
    if (!borrador || !this.map) {
      return;
    }
    this.pinBorrador?.remove();
    this.pinBorrador = L.marker([borrador.lat, borrador.lng], { draggable: true, zIndexOffset: 1000 })
      .addTo(this.map)
      .on('dragend', () => {
        const posicion = this.pinBorrador!.getLatLng();
        this.moverBorrador(posicion.lat, posicion.lng, null);
      });
    this.map.setView([borrador.lat, borrador.lng], Math.max(this.map.getZoom(), 16));
  }

  private moverBorrador(lat: number, lng: number, precision: number | null): void {
    const borrador = this.borrador();
    if (!borrador) {
      return;
    }
    this.borrador.set({ ...borrador, lat, lng, precision, direccion: '' });
    this.pinBorrador?.setLatLng([lat, lng]);
  }

  async usarMiUbicacion(): Promise<void> {
    await this.ubicarme(false);
    const yo = this.datos.miUbicacion();
    if (yo && this.map) {
      this.moverBorrador(yo.lat, yo.lng, yo.precision);
      this.map.setView([yo.lat, yo.lng], Math.max(this.map.getZoom(), 17));
    }
  }

  // Paso 2: con la ubicación ya elegida, se abre el formulario y se consulta la dirección.
  async continuarAlFormulario(): Promise<void> {
    const borrador = this.borrador();
    if (!borrador) {
      return;
    }
    this.modo.set('formulario');

    if (!borrador.direccion && this.datos.enLinea()) {
      this.editarBorrador({ buscandoDireccion: true });
      const direccion = await this.datos.buscarDireccion(borrador);
      const actual = this.borrador();
      // Solo se aplica si el pin sigue en el mismo sitio.
      if (actual && actual.lat === borrador.lat && actual.lng === borrador.lng) {
        this.borrador.set({ ...actual, direccion, buscandoDireccion: false });
      }
    }
  }

  // El formulario se cerró arrastrándolo hacia abajo: se vuelve a ubicar el pin.
  alCerrarFormulario(): void {
    if (this.modo() === 'formulario') {
      this.modo.set('ubicar');
    }
  }

  volverAUbicar(): void {
    this.modo.set('ubicar');
  }

  cancelarAgregar(): void {
    this.pinBorrador?.remove();
    this.pinBorrador = null;
    this.borrador.set(null);
    this.modo.set('ver');
  }

  editarBorrador(cambios: Partial<Borrador>): void {
    const borrador = this.borrador();
    if (borrador) {
      this.borrador.set({ ...borrador, ...cambios });
    }
  }

  // Los campos de texto de Ionic avisan con un evento cuyo detail trae el valor.
  textoDe(evento: Event): string {
    return ((evento as CustomEvent).detail?.value ?? '') as string;
  }

  async agregarFoto(origen: 'camara' | 'galeria'): Promise<void> {
    const borrador = this.borrador();
    if (!borrador || borrador.fotos.length >= MAX_FOTOS) {
      return;
    }
    const foto = await this.pedirFoto(origen);
    const actual = this.borrador();
    if (foto && actual) {
      this.borrador.set({ ...actual, fotos: [...actual.fotos, foto] });
    }
  }

  quitarFoto(indice: number): void {
    const borrador = this.borrador();
    if (borrador) {
      this.borrador.set({ ...borrador, fotos: borrador.fotos.filter((_, i) => i !== indice) });
    }
  }

  async guardarBorrador(): Promise<void> {
    const borrador = this.borrador();
    if (!borrador) {
      return;
    }

    const datos = {
      nombre: borrador.nombre.trim(),
      nota: borrador.nota.trim(),
      categoria: borrador.categoria,
      lat: borrador.lat,
      lng: borrador.lng,
      direccion: borrador.direccion,
      fotos: borrador.fotos,
    };

    if (borrador.id !== null) {
      if (!(await this.datos.actualizar(borrador.id, datos))) {
        this.avisar('No se pudo guardar: no queda espacio para más fotos.');
        return;
      }
      this.cancelarAgregar();
      this.avisar('Cambios guardados');
      return;
    }

    const nuevo = await this.datos.agregar(datos);
    if (!nuevo) {
      this.avisar('No se pudo guardar: no queda espacio para más fotos.');
      return;
    }
    this.cancelarAgregar();
    this.map?.setView([nuevo.lat, nuevo.lng], Math.max(this.map.getZoom(), 16));
    // Para los reportes se ofrece de una vez el recordatorio de seguimiento.
    if (nuevo.categoria === 'reporte') {
      const toast = await this.toasts.create({
        message: 'Reporte guardado',
        duration: 6000,
        position: 'top',
        buttons: [
          {
            text: 'Poner recordatorio',
            handler: () => {
              this.abrirPunto(nuevo.id, true);
              setTimeout(() => this.elegirRecordatorio(), 400);
            },
          },
        ],
      });
      await toast.present();
    } else {
      this.avisar('Punto guardado');
    }
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------

  private formatoDuracion(minutos: number): string {
    if (minutos < 60) {
      return `${minutos} min`;
    }
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `${horas} h ${resto} min` : `${horas} h`;
  }

  private async avisar(mensaje: string): Promise<void> {
    const toast = await this.toasts.create({ message: mensaje, duration: 2400, position: 'top' });
    await toast.present();
  }
}
