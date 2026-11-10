import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { environment } from '../environments/environment';

// ---------------------------------------------------------------------------
// Modelo de datos compartido por el mapa y la lista
// ---------------------------------------------------------------------------

export type Categoria =
  | 'mirador'
  | 'parque'
  | 'biblioteca'
  | 'museo'
  | 'monumento'
  | 'restaurante'
  | 'centro_comercial'
  | 'aeropuerto'
  | 'reporte'
  | 'casa'
  | 'otro';

// 'destacado': lugar famoso de Bogotá que viene con la app.
// 'propio': punto agregado por el usuario.
// 'comunidad': punto que otra persona publicó en Rolo (llega de la API).
export type Origen = 'destacado' | 'propio' | 'comunidad';

export interface Coordenada {
  lat: number;
  lng: number;
}

export interface Punto extends Coordenada {
  id: number;
  nombre: string;
  nota: string;
  categoria: Categoria;
  direccion: string;
  fotos: string[];
  fecha: string; // ISO
  origen: Origen;
  favorito: boolean;
  // Solo para reportes (huecos, daños): cuándo se arregló y la foto del después.
  resuelto: { fecha: string; foto: string | null } | null;
  // Id del punto en el servidor de Rolo (null si todavía no se ha publicado).
  remotoId: string | null;
  // Cuántas personas dijeron "Yo también lo vi" (solo reportes).
  confirmaciones: number;
}

// Punto tal como lo devuelve la API (rolo-api /api/v1/puntos).
interface PuntoApi {
  id: string;
  nombre: string;
  nota: string;
  categoria: Categoria;
  direccion: string;
  lat: number;
  lng: number;
  resuelto: boolean;
  fechaArreglo: string | null;
  confirmaciones: number;
  createdAt: string;
}

export interface DatosCategoria {
  id: Categoria;
  nombre: string;
  icono: string;
}

export const CATEGORIAS: DatosCategoria[] = [
  { id: 'reporte', nombre: 'Hueco o daño', icono: 'warning-outline' },
  { id: 'casa', nombre: 'Casa', icono: 'home-outline' },
  { id: 'mirador', nombre: 'Mirador', icono: 'eye-outline' },
  { id: 'parque', nombre: 'Parque', icono: 'leaf-outline' },
  { id: 'biblioteca', nombre: 'Biblioteca', icono: 'library-outline' },
  { id: 'museo', nombre: 'Museo', icono: 'business-outline' },
  { id: 'monumento', nombre: 'Monumento', icono: 'flag-outline' },
  { id: 'restaurante', nombre: 'Restaurante', icono: 'restaurant-outline' },
  { id: 'centro_comercial', nombre: 'Centro comercial', icono: 'bag-handle-outline' },
  { id: 'aeropuerto', nombre: 'Aeropuerto', icono: 'airplane-outline' },
  { id: 'otro', nombre: 'Otro', icono: 'location-outline' },
];

export const MAX_FOTOS = 4;

// Palabras relacionadas con cada categoría: buscar "bache" encuentra los
// huecos, "comida" los restaurantes, etc.
const PALABRAS_CLAVE: Record<Categoria, string> = {
  reporte: 'hueco bache hoyo daño dañado roto reporte incidencia problema alumbrado basura',
  mirador: 'mirador vista panoramica paisaje cerro montaña',
  parque: 'parque verde naturaleza arboles jardin deporte',
  biblioteca: 'biblioteca libros lectura estudio leer',
  museo: 'museo arte historia cultura exposicion',
  monumento: 'monumento plaza historico estatua iglesia',
  restaurante: 'restaurante comida comer almuerzo cafe cafeteria',
  centro_comercial: 'centro comercial compras tiendas mall',
  aeropuerto: 'aeropuerto avion vuelo viaje terminal',
  casa: 'casa hogar mi casa apartamento apto residencia vivienda familia',
  otro: 'otro lugar sitio',
};

export interface Resultado {
  punto: Punto;
  puntaje: number;
}

const STORAGE_PUNTOS = 'puntos_v2';
const STORAGE_TANDA = 'destacados_tanda';
// Puntos de la comunidad que el usuario quitó de su mapa y reportes que ya confirmó.
const STORAGE_OCULTOS = 'comunidad_ocultos';
const STORAGE_CONFIRMADOS = 'reportes_confirmados';
// Llave secreta de este celular: prueba ante el servidor que los puntos son suyos.
const STORAGE_LLAVE = 'llave_dispositivo';

// Servidor de Rolo. La casa nunca se publica: es privada.
const API = environment.apiUrl;
const NO_SE_PUBLICA: Categoria[] = ['casa'];
// Cada cuánto se traen los puntos nuevos de la comunidad mientras la app está abierta.
const INTERVALO_SINCRONIZACION = 2 * 60_000;
// Si traer la comunidad tarda más que esto (servidor despertando), se avisa en pantalla.
const ESPERA_ANTES_DE_AVISAR = 1200;
// Un punto de la comunidad se considera repetido si está a menos de esto
// de otro que ya se ve en el mapa y se llama parecido.
const DISTANCIA_REPETIDO = 40;
// Claves de versiones anteriores de la app; solo se leen una vez para migrar.
const STORAGE_FOTOS_VIEJAS = 'puntos_guardados';

// Lugares famosos de Bogotá que vienen con la app. "tanda" indica en qué
// versión de la lista se agregó cada uno, para sumar los nuevos a quien ya
// tenía la app sin devolverle los que haya borrado.
const TANDA_ACTUAL = 2;

interface Destacado {
  id: number;
  tanda: number;
  nombre: string;
  categoria: Categoria;
  lat: number;
  lng: number;
  nota: string;
  // Qué buscar para conseguir la foto del lugar.
  foto: string;
}

const DESTACADOS: Destacado[] = [
  { id: 1, tanda: 1, nombre: 'Monserrate', categoria: 'mirador', lat: 4.6058, lng: -74.0565, nota: 'Cerro con santuario y la vista más conocida de Bogotá.', foto: 'Cerro de Monserrate' },
  { id: 2, tanda: 1, nombre: 'Biblioteca Luis Ángel Arango', categoria: 'biblioteca', lat: 4.5968, lng: -74.073, nota: 'Biblioteca pública del Banco de la República en La Candelaria.', foto: 'Biblioteca Luis Ángel Arango' },
  { id: 3, tanda: 1, nombre: 'Parque El Tunal', categoria: 'parque', lat: 4.5725, lng: -74.1335, nota: 'Parque metropolitano del sur de la ciudad.', foto: 'Parque El Tunal Bogotá' },
  { id: 4, tanda: 1, nombre: 'Parque Simón Bolívar', categoria: 'parque', lat: 4.658, lng: -74.0935, nota: 'El parque urbano más grande de Bogotá.', foto: 'Parque Metropolitano Simón Bolívar' },
  { id: 5, tanda: 1, nombre: 'Aeropuerto El Dorado', categoria: 'aeropuerto', lat: 4.7016, lng: -74.1469, nota: 'Aeropuerto internacional de Bogotá.', foto: 'Aeropuerto Internacional El Dorado' },
  { id: 6, tanda: 1, nombre: 'Centro Mayor', categoria: 'centro_comercial', lat: 4.5923, lng: -74.124, nota: 'Centro comercial del sur de Bogotá.', foto: 'Centro Mayor centro comercial Bogotá' },
  { id: 7, tanda: 1, nombre: 'La Puerta Falsa', categoria: 'restaurante', lat: 4.5981, lng: -74.0748, nota: 'Restaurante tradicional junto a la Plaza de Bolívar.', foto: 'La Puerta Falsa Bogotá' },
  { id: 8, tanda: 1, nombre: 'Plaza de Bolívar', categoria: 'monumento', lat: 4.5981, lng: -74.076, nota: 'Plaza principal de Bogotá, rodeada por la Catedral y el Capitolio.', foto: 'Plaza de Bolívar Bogotá' },
  { id: 9, tanda: 1, nombre: 'Museo del Oro', categoria: 'museo', lat: 4.6019, lng: -74.0721, nota: 'Museo de orfebrería prehispánica del Banco de la República.', foto: 'Museo del Oro Bogotá' },
  { id: 10, tanda: 1, nombre: 'Centro Comercial Andino', categoria: 'centro_comercial', lat: 4.6668, lng: -74.053, nota: 'Centro comercial de la Zona Rosa.', foto: 'Centro Andino Bogotá' },
  { id: 11, tanda: 2, nombre: 'Jardín Botánico de Bogotá', categoria: 'parque', lat: 4.6686, lng: -74.099, nota: 'Jardín botánico José Celestino Mutis, con plantas de todos los climas del país.', foto: 'Jardín Botánico de Bogotá José Celestino Mutis' },
  { id: 12, tanda: 2, nombre: 'Museo Nacional de Colombia', categoria: 'museo', lat: 4.6155, lng: -74.0687, nota: 'El museo más antiguo del país, en una antigua penitenciaría.', foto: 'Museo Nacional de Colombia' },
  { id: 13, tanda: 2, nombre: 'Museo Botero', categoria: 'museo', lat: 4.5967, lng: -74.0733, nota: 'Colección donada por Fernando Botero, en La Candelaria.', foto: 'Museo Botero Bogotá' },
  { id: 14, tanda: 2, nombre: 'Chorro de Quevedo', categoria: 'monumento', lat: 4.5972, lng: -74.0697, nota: 'Plazoleta donde, según la tradición, se fundó Bogotá.', foto: 'Chorro de Quevedo' },
  { id: 15, tanda: 2, nombre: 'Torre Colpatria', categoria: 'mirador', lat: 4.611, lng: -74.0705, nota: 'Rascacielos del centro con mirador en la terraza.', foto: 'Torre Colpatria' },
  { id: 16, tanda: 2, nombre: 'Mirador de La Calera', categoria: 'mirador', lat: 4.6717, lng: -74.023, nota: 'Vista panorámica de la ciudad desde la vía a La Calera.', foto: 'La Calera Cundinamarca mirador' },
  { id: 17, tanda: 2, nombre: 'Parque de la 93', categoria: 'parque', lat: 4.6767, lng: -74.0483, nota: 'Parque rodeado de restaurantes y cafés en el norte.', foto: 'Parque de la 93 Bogotá' },
  { id: 18, tanda: 2, nombre: 'Plaza de Usaquén', categoria: 'monumento', lat: 4.695, lng: -74.031, nota: 'Plaza colonial con mercado de las pulgas los domingos.', foto: 'Usaquén Bogotá' },
  { id: 19, tanda: 2, nombre: 'Centro Comercial Santafé', categoria: 'centro_comercial', lat: 4.7625, lng: -74.046, nota: 'Uno de los centros comerciales más grandes de la ciudad.', foto: 'Centro Comercial Santafé Bogotá' },
  { id: 20, tanda: 2, nombre: 'Unicentro', categoria: 'centro_comercial', lat: 4.702, lng: -74.0415, nota: 'Centro comercial tradicional del norte de Bogotá.', foto: 'Unicentro Bogotá' },
];

@Injectable({ providedIn: 'root' })
export class PuntosService {
  readonly categorias = CATEGORIAS;

  puntos = signal<Punto[]>([]);
  // Hay conexión a internet. Se actualiza solo con los eventos del navegador.
  enLinea = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  // Última ubicación conocida del usuario (la actualiza el mapa).
  miUbicacion = signal<(Coordenada & { precision: number }) | null>(null);
  // La lista le pide al mapa que abra un punto dejando aquí su id.
  puntoParaAbrir = signal<number | null>(null);

  // Reportes en los que este usuario ya tocó "Yo también lo vi".
  confirmados = signal<string[]>([]);
  // Se están trayendo los puntos de la comunidad y está tardando (para mostrar el aviso).
  actualizando = signal(false);

  private carga: Promise<void> | null = null;
  private ocultos: string[] = [];
  private sincronizacion: Promise<void> | null = null;
  // Arreglado / sin arreglar que no se pudo enviar (sin internet); se reintenta.
  private estadosPendientes = new Map<string, boolean>();
  private llave = '';

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => this.enLinea.set(false));
      window.addEventListener('online', () => {
        this.enLinea.set(true);
        // Al recuperar conexión se completan las fotos que falten
        // y se publica lo que se agregó sin internet.
        this.cargarFotosDestacados();
        this.sincronizar();
      });
      // Al volver a la app se traen los puntos nuevos de la comunidad.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.sincronizar();
        }
      });
      setInterval(() => this.sincronizar(), INTERVALO_SINCRONIZACION);
    }
  }

  // Carga los puntos una sola vez, sin importar qué pantalla la pida primero.
  cargar(): Promise<void> {
    if (!this.carga) {
      this.carga = this.cargarDeVerdad();
    }
    return this.carga;
  }

  private async cargarDeVerdad(): Promise<void> {
    const { value } = await Preferences.get({ key: STORAGE_PUNTOS });
    const tandaGuardada = Number((await Preferences.get({ key: STORAGE_TANDA })).value ?? 0);

    let puntos: Punto[];
    if (value) {
      puntos = (JSON.parse(value) as any[]).map((p) => this.normalizar(p));
      // Quien ya tenía la app (con los 10 primeros) recibe solo los nuevos.
      const desde = tandaGuardada || 1;
      const presentes = new Set(puntos.map((p) => p.id));
      const nuevos = DESTACADOS.filter((d) => d.tanda > desde && !presentes.has(d.id));
      puntos = [...puntos, ...nuevos.map((d) => this.puntoDestacado(d))];
    } else {
      puntos = await this.puntosDePrimeraVez();
    }

    this.ocultos = await this.leerJson<string[]>(STORAGE_OCULTOS, []);
    this.confirmados.set(await this.leerJson<string[]>(STORAGE_CONFIRMADOS, []));
    this.llave = await this.llaveDelCelular();

    await this.guardar(puntos);
    await Preferences.set({ key: STORAGE_TANDA, value: String(TANDA_ACTUAL) });
    this.cargarFotosDestacados();
    // Sin esperar: el mapa se muestra de una vez y la comunidad llega después.
    this.sincronizar();
  }

  private puntoDestacado(d: Destacado): Punto {
    return {
      id: d.id,
      nombre: d.nombre,
      nota: d.nota,
      categoria: d.categoria,
      lat: d.lat,
      lng: d.lng,
      direccion: '',
      fotos: [],
      fecha: new Date().toISOString(),
      origen: 'destacado',
      favorito: false,
      resuelto: null,
      remotoId: null,
      confirmaciones: 0,
    };
  }

  // Deja con el formato actual los puntos guardados por versiones anteriores.
  private normalizar(p: any): Punto {
    return {
      id: p.id,
      nombre: p.nombre ?? p.titulo ?? '',
      nota: p.nota ?? p.descripcion ?? '',
      categoria: p.categoria ?? 'otro',
      lat: p.lat,
      lng: p.lng,
      direccion: p.direccion ?? '',
      fotos: Array.isArray(p.fotos) ? p.fotos : p.foto ? [p.foto] : [],
      fecha: p.fecha ?? new Date().toISOString(),
      origen: p.origen ?? (DESTACADOS.some((d) => d.id === p.id) ? 'destacado' : 'propio'),
      favorito: !!p.favorito,
      resuelto: p.resuelto ?? null,
      remotoId: p.remotoId ?? null,
      confirmaciones: p.confirmaciones ?? 0,
    };
  }

  private async puntosDePrimeraVez(): Promise<Punto[]> {
    const ahora = new Date().toISOString();
    const fotosViejas = await this.leerJson<any[]>(STORAGE_FOTOS_VIEJAS, []);

    // Fotos sueltas guardadas con la primera versión de la app.
    const migrados: Punto[] = fotosViejas
      .filter((viejo) => typeof viejo?.lat === 'number' && typeof viejo?.lng === 'number')
      .map((viejo, indice) => ({
        id: Date.now() + indice,
        nombre: viejo.lugar ? `Foto cerca de ${viejo.lugar}` : 'Foto guardada',
        nota: '',
        categoria: 'otro' as Categoria,
        lat: viejo.lat,
        lng: viejo.lng,
        direccion: '',
        fotos: viejo.foto ? [viejo.foto] : [],
        fecha: ahora,
        origen: 'propio' as Origen,
        favorito: false,
        resuelto: null,
        remotoId: null,
        confirmaciones: 0,
      }));

    return [...DESTACADOS.map((d) => this.puntoDestacado(d)), ...migrados];
  }

  private async leerJson<T>(clave: string, porDefecto: T): Promise<T> {
    try {
      const { value } = await Preferences.get({ key: clave });
      return value ? JSON.parse(value) : porDefecto;
    } catch {
      return porDefecto;
    }
  }

  // Guarda la lista completa. Devuelve false si el dispositivo no tiene espacio.
  private async guardar(puntos: Punto[]): Promise<boolean> {
    try {
      await Preferences.set({ key: STORAGE_PUNTOS, value: JSON.stringify(puntos) });
      this.puntos.set(puntos);
      return true;
    } catch (error) {
      console.error('No se pudo guardar', error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Crear, cambiar y eliminar
  // -------------------------------------------------------------------------

  async agregar(
    datos: Omit<Punto, 'id' | 'fecha' | 'origen' | 'favorito' | 'resuelto' | 'remotoId' | 'confirmaciones'>
  ): Promise<Punto | null> {
    const nuevo: Punto = {
      ...datos,
      id: Date.now(),
      fecha: new Date().toISOString(),
      origen: 'propio',
      favorito: false,
      resuelto: null,
      remotoId: null,
      confirmaciones: 0,
    };
    if (!(await this.guardar([...this.puntos(), nuevo]))) {
      return null;
    }
    // Se publica en segundo plano; si no hay internet, se publica al volver.
    this.publicar(nuevo);
    return nuevo;
  }

  async actualizar(id: number, cambios: Partial<Punto>): Promise<boolean> {
    const antes = this.puntos().find((p) => p.id === id);
    const guardado = await this.guardarSolo(id, cambios);
    if (guardado && antes) {
      this.enviarCambios(antes, cambios);
    }
    return guardado;
  }

  // Cambia el punto solo en el celular, sin avisarle al servidor.
  private guardarSolo(id: number, cambios: Partial<Punto>): Promise<boolean> {
    return this.guardar(this.puntos().map((p) => (p.id === id ? { ...p, ...cambios } : p)));
  }

  // Marca o desmarca un punto como favorito (los favoritos son personales).
  alternarFavorito(id: number): Promise<boolean> {
    const punto = this.puntos().find((p) => p.id === id);
    return punto ? this.guardarSolo(id, { favorito: !punto.favorito }) : Promise.resolve(false);
  }

  // Reportes: marcar como arreglado (con foto opcional del después) o reabrir.
  // El estado se comparte: todos ven que el hueco ya se arregló.
  async marcarArreglado(id: number, foto: string | null): Promise<boolean> {
    const ok = await this.guardarSolo(id, { resuelto: { fecha: new Date().toISOString(), foto } });
    if (ok) {
      this.enviarEstado(id, true);
    }
    return ok;
  }

  async reabrir(id: number): Promise<boolean> {
    const ok = await this.guardarSolo(id, { resuelto: null });
    if (ok) {
      this.enviarEstado(id, false);
    }
    return ok;
  }

  // "Yo también lo vi": suma una confirmación al reporte de otra persona.
  async confirmar(id: number): Promise<boolean> {
    const punto = this.puntos().find((p) => p.id === id);
    if (!punto?.remotoId || this.yaConfirmado(punto)) {
      return false;
    }
    const respuesta = await this.pedir<PuntoApi>(`/${punto.remotoId}/confirmar`, { method: 'POST' });
    if (!respuesta) {
      return false;
    }
    const confirmados = [...this.confirmados(), punto.remotoId];
    this.confirmados.set(confirmados);
    await Preferences.set({ key: STORAGE_CONFIRMADOS, value: JSON.stringify(confirmados) });
    await this.guardarSolo(id, { confirmaciones: respuesta.confirmaciones });
    return true;
  }

  yaConfirmado(punto: Punto): boolean {
    return !!punto.remotoId && this.confirmados().includes(punto.remotoId);
  }

  // Los puntos propios se borran también del servidor. Los de la comunidad
  // no son del usuario: solo se quitan de su mapa.
  async eliminar(id: number): Promise<boolean> {
    const punto = this.puntos().find((p) => p.id === id);
    const ok = await this.guardar(this.puntos().filter((p) => p.id !== id));
    if (!ok || !punto?.remotoId) {
      return ok;
    }
    // Se oculta siempre: si el servidor no deja borrarlo, no vuelve a aparecer.
    this.ocultos = [...this.ocultos, punto.remotoId];
    await Preferences.set({ key: STORAGE_OCULTOS, value: JSON.stringify(this.ocultos) });
    if (punto.origen === 'propio') {
      this.pedir(`/${punto.remotoId}`, { method: 'DELETE' });
    }
    return ok;
  }

  // -------------------------------------------------------------------------
  // Servidor de Rolo (rolo-api)
  // Lo propio se publica para que otros lo vean, y los puntos de los demás
  // llegan como "comunidad". Todo sigue funcionando sin internet: lo que no
  // se pudo publicar se publica en la siguiente sincronización.
  // -------------------------------------------------------------------------

  sincronizar(): Promise<void> {
    if (!this.enLinea() || !this.carga) {
      return Promise.resolve();
    }
    if (!this.sincronizacion) {
      const aviso = setTimeout(() => this.actualizando.set(true), ESPERA_ANTES_DE_AVISAR);
      this.sincronizacion = this.sincronizarDeVerdad().finally(() => {
        clearTimeout(aviso);
        this.sincronizacion = null;
        this.actualizando.set(false);
      });
    }
    return this.sincronizacion;
  }

  private async sincronizarDeVerdad(): Promise<void> {
    await this.carga;

    // 1. Publicar lo propio que aún no está en el servidor.
    for (const punto of this.puntos()) {
      if (punto.origen === 'propio' && !punto.remotoId && this.sePublica(punto)) {
        await this.publicar(punto);
      }
    }

    for (const [remotoId, resuelto] of [...this.estadosPendientes]) {
      if (await this.pedir(`/${remotoId}/estado`, { method: 'PATCH', body: JSON.stringify({ resuelto }) })) {
        this.estadosPendientes.delete(remotoId);
      }
    }

    // 2. Traer todos los puntos del servidor.
    const remotos = await this.pedir<PuntoApi[]>('?limite=500');
    if (!remotos) {
      return;
    }
    const porId = new Map(remotos.map((r) => [r.id, r]));
    const actuales = this.puntos();

    // 3. Lo propio: se actualiza el estado y las confirmaciones que pusieron otros.
    const propios = actuales
      .filter((p) => p.origen !== 'comunidad')
      .map((p) => {
        const remoto = p.remotoId ? porId.get(p.remotoId) : undefined;
        return remoto ? { ...p, ...this.estadoDesde(remoto, p) } : p;
      });
    const mios = new Set(propios.map((p) => p.remotoId).filter(Boolean));

    // 4. Lo de los demás, conservando lo personal (favorito, fotos que se le agregaron).
    // Si alguien publicó un lugar que ya está (por ejemplo "Monserrate"), no se repite.
    const anteriores = new Map(actuales.filter((p) => p.origen === 'comunidad').map((p) => [p.remotoId, p]));
    const comunidad = remotos
      .filter((r) => !mios.has(r.id) && !this.ocultos.includes(r.id))
      .map((r) => this.puntoDeComunidad(r, anteriores.get(r.id)))
      .filter((c) => !propios.some((p) => this.esRepetido(c, p)));

    await this.guardar([...propios, ...comunidad]);
  }

  // Mismo lugar: muy cerca y con un nombre que coincide (sin tildes ni mayúsculas).
  private esRepetido(a: Punto, b: Punto): boolean {
    if (a.categoria === 'reporte' || b.categoria === 'reporte') {
      return false; // dos reportes cercanos pueden ser dos huecos distintos
    }
    if (this.distancia(a, b) > DISTANCIA_REPETIDO) {
      return false;
    }
    const nombreA = this.palabrasDe(a.nombre).join(' ');
    const nombreB = this.palabrasDe(b.nombre).join(' ');
    return !!nombreA && !!nombreB && (nombreA.includes(nombreB) || nombreB.includes(nombreA));
  }

  // Los puntos de la comunidad solo los puede editar quien los publicó.
  sePuedeEditar(punto: Punto): boolean {
    return punto.origen !== 'comunidad';
  }

  private async llaveDelCelular(): Promise<string> {
    const { value } = await Preferences.get({ key: STORAGE_LLAVE });
    if (value) {
      return value;
    }
    const nueva =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID() + crypto.randomUUID()
        : Array.from({ length: 48 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    await Preferences.set({ key: STORAGE_LLAVE, value: nueva });
    return nueva;
  }

  private sePublica(punto: Punto): boolean {
    return !NO_SE_PUBLICA.includes(punto.categoria);
  }

  // Sube un punto propio al servidor y guarda el id que le asignó.
  private async publicar(punto: Punto): Promise<void> {
    if (!this.sePublica(punto) || !this.enLinea()) {
      return;
    }
    const creado = await this.pedir<PuntoApi>('', {
      method: 'POST',
      body: JSON.stringify(this.cuerpo(punto)),
    });
    if (!creado) {
      return;
    }
    if (punto.resuelto && punto.categoria === 'reporte') {
      await this.pedir(`/${creado.id}/estado`, { method: 'PATCH', body: JSON.stringify({ resuelto: true }) });
    }
    // Si mientras tanto se borró, no se deja huérfano en el servidor.
    if (!this.puntos().some((p) => p.id === punto.id)) {
      await this.pedir(`/${creado.id}`, { method: 'DELETE' });
      return;
    }
    await this.guardarSolo(punto.id, { remotoId: creado.id });
  }

  // Lleva al servidor los cambios de texto, categoría o ubicación.
  private enviarCambios(antes: Punto, cambios: Partial<Punto>): void {
    if (antes.origen !== 'propio') {
      return;
    }
    const despues = { ...antes, ...cambios };
    // Si ahora es la casa, deja de ser público.
    if (antes.remotoId && antes.origen === 'propio' && !this.sePublica(despues)) {
      this.pedir(`/${antes.remotoId}`, { method: 'DELETE' });
      this.guardarSolo(antes.id, { remotoId: null });
      return;
    }
    if (!antes.remotoId) {
      if (antes.origen === 'propio') {
        this.publicar(despues);
      }
      return;
    }
    const campos: (keyof Punto)[] = ['nombre', 'nota', 'categoria', 'direccion', 'lat', 'lng'];
    if (campos.some((c) => c in cambios)) {
      this.pedir(`/${antes.remotoId}`, { method: 'PUT', body: JSON.stringify(this.cuerpo(despues)) });
    }
  }

  private async enviarEstado(id: number, resuelto: boolean): Promise<void> {
    const punto = this.puntos().find((p) => p.id === id);
    if (!punto?.remotoId || punto.categoria !== 'reporte') {
      return;
    }
    const remotoId = punto.remotoId;
    this.estadosPendientes.set(remotoId, resuelto);
    if (await this.pedir(`/${remotoId}/estado`, { method: 'PATCH', body: JSON.stringify({ resuelto }) })) {
      this.estadosPendientes.delete(remotoId);
    }
  }

  private cuerpo(p: Punto) {
    return {
      nombre: p.nombre.slice(0, 80),
      nota: p.nota.slice(0, 500),
      categoria: p.categoria,
      direccion: p.direccion.slice(0, 200),
      lat: p.lat,
      lng: p.lng,
    };
  }

  // Estado y confirmaciones según el servidor, sin perder la foto del después.
  private estadoDesde(r: PuntoApi, local?: Punto): Pick<Punto, 'resuelto' | 'confirmaciones'> {
    if (local && this.estadosPendientes.has(r.id)) {
      return { confirmaciones: r.confirmaciones ?? 0, resuelto: local.resuelto };
    }
    return {
      confirmaciones: r.confirmaciones ?? 0,
      resuelto: r.resuelto
        ? { fecha: r.fechaArreglo ?? new Date().toISOString(), foto: local?.resuelto?.foto ?? null }
        : null,
    };
  }

  private puntoDeComunidad(r: PuntoApi, anterior?: Punto): Punto {
    return {
      // Id numérico estable sacado del id del servidor (fecha + parte aleatoria).
      id: anterior?.id ?? parseInt(r.id.slice(0, 13), 16),
      nombre: r.nombre,
      nota: r.nota,
      categoria: CATEGORIAS.some((c) => c.id === r.categoria) ? r.categoria : 'otro',
      lat: r.lat,
      lng: r.lng,
      direccion: r.direccion,
      fotos: anterior?.fotos ?? [],
      fecha: r.createdAt,
      origen: 'comunidad',
      favorito: anterior?.favorito ?? false,
      remotoId: r.id,
      ...this.estadoDesde(r, anterior),
    };
  }

  // Llama a la API. Devuelve null si no hay conexión o el servidor falla:
  // la app nunca se rompe por culpa del servidor.
  private async pedir<T = unknown>(ruta: string, opciones: RequestInit = {}): Promise<T | null> {
    if (!this.enLinea()) {
      return null;
    }
    try {
      const respuesta = await fetch(API + ruta, {
        ...opciones,
        headers: {
          'Content-Type': 'application/json',
          // El servidor solo deja editar o borrar un punto al celular que lo publicó.
          'X-Rolo-Llave': this.llave,
          ...(opciones.headers ?? {}),
        },
      });
      if (!respuesta.ok) {
        console.warn('rolo-api respondió', respuesta.status, ruta);
        return null;
      }
      return respuesta.status === 204 ? (true as T) : ((await respuesta.json()) as T);
    } catch (error) {
      console.warn('No se pudo hablar con rolo-api', error);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Datos de apoyo: dirección, fotos y textos
  // -------------------------------------------------------------------------

  // Convierte coordenadas en una dirección legible (servicio Nominatim de OpenStreetMap).
  async buscarDireccion(coordenada: Coordenada): Promise<string> {
    if (!this.enLinea()) {
      return '';
    }
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=es&lat=${coordenada.lat}&lon=${coordenada.lng}`;
      const datos = await (await fetch(url)).json();
      const d = datos.address;
      if (!d) {
        return '';
      }
      const calle = [d.road, d.house_number].filter(Boolean).join(' # ');
      const zona = d.neighbourhood || d.suburb || d.quarter;
      const ciudad = d.city || d.town || d.village || d.county;
      const partes = [calle, zona, ciudad].filter(Boolean);
      return partes.length ? partes.join(', ') : (datos.display_name ?? '');
    } catch {
      return '';
    }
  }

  // Les pone foto a los lugares destacados que aún no tienen.
  private async cargarFotosDestacados(): Promise<void> {
    if (!this.enLinea()) {
      return;
    }
    for (const destacado of DESTACADOS) {
      const punto = this.puntos().find((p) => p.id === destacado.id);
      if (!punto || punto.origen !== 'destacado' || punto.fotos.length) {
        continue;
      }
      const foto = await this.buscarFotoEnWikipedia(destacado.foto);
      if (foto) {
        await this.actualizar(punto.id, { fotos: [foto] });
      }
    }
  }

  private async buscarFotoEnWikipedia(busqueda: string): Promise<string | null> {
    try {
      const url =
        'https://es.wikipedia.org/w/api.php?action=query&format=json&origin=*' +
        '&generator=search&gsrlimit=1&prop=pageimages&pithumbsize=640' +
        `&gsrsearch=${encodeURIComponent(busqueda)}`;
      const datos = await (await fetch(url)).json();
      const paginas = Object.values(datos.query?.pages ?? {}) as any[];
      return paginas[0]?.thumbnail?.source ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Buscador
  // Encuentra puntos desde la primera letra. No distingue mayúsculas ni
  // tildes, busca por inicio de palabra o dentro de ella, tolera errores de
  // tecleo ("bibloteca") y entiende palabras relacionadas ("comida").
  // Todas las palabras escritas deben coincidir; los mejores van primero.
  // -------------------------------------------------------------------------

  buscar(texto: string): Resultado[] {
    const palabras = this.palabrasDe(texto);
    if (!palabras.length) {
      return [];
    }

    const resultados: Resultado[] = [];
    for (const punto of this.puntos()) {
      // Cada campo pesa distinto: coincidir en el nombre vale más que en la nota.
      const campos: { palabras: string[]; peso: number }[] = [
        { palabras: this.palabrasDe(punto.nombre), peso: 5 },
        { palabras: this.palabrasDe(this.categoria(punto.categoria).nombre), peso: 4 },
        { palabras: this.palabrasDe(PALABRAS_CLAVE[punto.categoria]), peso: 3 },
        { palabras: this.palabrasDe(punto.direccion), peso: 2 },
        { palabras: this.palabrasDe(punto.nota), peso: 1 },
      ];

      let puntaje = 0;
      let todasCoinciden = true;
      for (const buscada of palabras) {
        let mejor = 0;
        for (const campo of campos) {
          for (const palabra of campo.palabras) {
            mejor = Math.max(mejor, this.parecido(buscada, palabra) * campo.peso);
          }
        }
        if (mejor === 0) {
          todasCoinciden = false;
          break;
        }
        puntaje += mejor;
      }

      if (todasCoinciden) {
        resultados.push({ punto, puntaje });
      }
    }

    return resultados.sort(
      (a, b) => b.puntaje - a.puntaje || b.punto.fecha.localeCompare(a.punto.fecha)
    );
  }

  // Texto en minúsculas, sin tildes y separado en palabras.
  private palabrasDe(texto: string): string[] {
    return (texto ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9ñ]+/)
      .filter(Boolean);
  }

  // Qué tanto se parece lo buscado a una palabra del punto, de 0 a 1.
  private parecido(buscada: string, palabra: string): number {
    if (palabra === buscada) {
      return 1;
    }
    if (palabra.startsWith(buscada)) {
      return 0.9;
    }
    if (buscada.length >= 3 && palabra.includes(buscada)) {
      return 0.6;
    }
    // Errores de tecleo: se compara con el inicio de la palabra y se permite
    // 1 letra distinta (2 si lo buscado es largo).
    if (buscada.length >= 4) {
      const permitidas = buscada.length >= 8 ? 2 : 1;
      for (const largo of [buscada.length - 1, buscada.length, buscada.length + 1]) {
        if (largo <= palabra.length && this.distanciaDeTecleo(buscada, palabra.slice(0, largo)) <= permitidas) {
          return 0.4;
        }
      }
    }
    return 0;
  }

  // Distancia de Levenshtein: cuántas letras hay que cambiar, quitar o poner.
  private distanciaDeTecleo(a: string, b: string): number {
    let fila = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const nueva = [i];
      for (let j = 1; j <= b.length; j++) {
        nueva[j] = Math.min(
          fila[j] + 1,
          nueva[j - 1] + 1,
          fila[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      fila = nueva;
    }
    return fila[b.length];
  }

  categoria(id: Categoria): DatosCategoria {
    return CATEGORIAS.find((c) => c.id === id) ?? CATEGORIAS[CATEGORIAS.length - 1];
  }

  // Título que se muestra de un punto: su nombre o, si no tiene, la dirección.
  titulo(punto: Punto): string {
    return punto.nombre || punto.direccion || this.categoria(punto.categoria).nombre;
  }

  // Distancia en línea recta entre dos coordenadas (fórmula de Haversine), en metros.
  distancia(a: Coordenada, b: Coordenada): number {
    const R = 6371e3;
    const phi1 = (a.lat * Math.PI) / 180;
    const phi2 = (b.lat * Math.PI) / 180;
    const deltaPhi = ((b.lat - a.lat) * Math.PI) / 180;
    const deltaLambda = ((b.lng - a.lng) * Math.PI) / 180;

    const h =
      Math.sin(deltaPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  formatoDistancia(metros: number): string {
    return metros < 1000 ? `${Math.round(metros)} m` : `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
  }

  textoCoordenadas(coordenada: Coordenada): string {
    return `${coordenada.lat.toFixed(5)}, ${coordenada.lng.toFixed(5)}`;
  }
}
