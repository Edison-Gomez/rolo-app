import { Component, OnInit, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Categoria, Origen, Punto, PuntosService } from '../puntos.service';

type FiltroOrigen = 'todos' | Origen;
type Orden = 'recientes' | 'cercanos' | 'nombre';

interface Fila {
  id: number;
  titulo: string;
  subtitulo: string;
  foto: string | null;
  icono: string;
  distancia: string | null;
  favorito: boolean;
  // Solo para reportes.
  estadoReporte: 'pendiente' | 'arreglado' | null;
}

@Component({
  selector: 'app-tab2',
  templateUrl: 'tab2.page.html',
  styleUrls: ['tab2.page.scss'],
  standalone: false,
})
export class Tab2Page implements OnInit {
  readonly origenes: { id: FiltroOrigen; nombre: string }[] = [
    { id: 'todos', nombre: 'Todos' },
    { id: 'destacado', nombre: 'Destacados' },
    { id: 'propio', nombre: 'Míos' },
    { id: 'comunidad', nombre: 'Comunidad' },
  ];

  readonly ordenes: { id: Orden; nombre: string; icono: string }[] = [
    { id: 'recientes', nombre: 'Más recientes', icono: 'time-outline' },
    { id: 'cercanos', nombre: 'Más cerca de mí', icono: 'navigate-outline' },
    { id: 'nombre', nombre: 'Nombre (A–Z)', icono: 'text-outline' },
  ];

  filtroOrigen = signal<FiltroOrigen>('todos');
  orden = signal<Orden>('recientes');
  // Categorías marcadas en el panel de filtros (vacío = todas).
  categoriasElegidas = signal<Categoria[]>([]);
  soloFavoritos = signal(false);
  ocultarArreglados = signal(false);
  panelFiltros = signal(false);
  busqueda = signal('');

  // Todas las categorías con cuántos puntos tiene cada una, para el panel.
  categoriasConConteo = computed(() =>
    this.datos.categorias.map((c) => ({
      ...c,
      cantidad: this.datos.puntos().filter((p) => p.categoria === c.id).length,
    }))
  );

  cantidadFavoritos = computed(() => this.datos.puntos().filter((p) => p.favorito).length);
  cantidadArreglados = computed(() => this.datos.puntos().filter((p) => p.resuelto).length);

  // Filtros aplicados, para mostrarlos como etiquetas que se pueden quitar.
  filtrosActivos = computed(() => {
    const activos: { texto: string; quitar: () => void }[] = [];
    if (this.filtroOrigen() === 'destacado') {
      activos.push({ texto: 'Destacados de Bogotá', quitar: () => this.filtroOrigen.set('todos') });
    }
    if (this.filtroOrigen() === 'propio') {
      activos.push({ texto: 'Agregados por mí', quitar: () => this.filtroOrigen.set('todos') });
    }
    if (this.soloFavoritos()) {
      activos.push({ texto: 'Favoritos', quitar: () => this.soloFavoritos.set(false) });
    }
    if (this.ocultarArreglados()) {
      activos.push({ texto: 'Sin reportes arreglados', quitar: () => this.ocultarArreglados.set(false) });
    }
    this.categoriasElegidas().forEach((id) =>
      activos.push({ texto: this.datos.categoria(id).nombre, quitar: () => this.alternarCategoria(id) })
    );
    return activos;
  });

  nombreDelOrden = computed(() => this.ordenes.find((o) => o.id === this.orden())?.nombre ?? '');

  // Puntos que pasan la búsqueda y los filtros, ya ordenados.
  private visibles = computed(() => {
    const origen = this.filtroOrigen();
    const categorias = this.categoriasElegidas();
    const favoritos = this.soloFavoritos();
    const sinArreglados = this.ocultarArreglados();
    const texto = this.busqueda().trim();
    const yo = this.datos.miUbicacion();
    // Con texto en el buscador solo quedan los puntos que coinciden.
    const base = texto ? this.datos.buscar(texto).map((r) => r.punto) : [...this.datos.puntos()];
    const filtrados = base.filter(
      (p) =>
        (origen === 'todos' || p.origen === origen) &&
        (!categorias.length || categorias.includes(p.categoria)) &&
        (!favoritos || p.favorito) &&
        (!sinArreglados || !p.resuelto)
    );

    switch (this.orden()) {
      case 'cercanos':
        // Sin ubicación no se puede ordenar por cercanía: se deja por nombre.
        return yo
          ? filtrados.sort((a, b) => this.datos.distancia(yo, a) - this.datos.distancia(yo, b))
          : filtrados.sort((a, b) => this.porNombre(a, b));
      case 'nombre':
        return filtrados.sort((a, b) => this.porNombre(a, b));
      default:
        return filtrados.sort((a, b) => b.fecha.localeCompare(a.fecha));
    }
  });

  total = computed(() => this.visibles().length);

  // Los puntos visibles en grupos. Por fecha: primero los tuyos, día por día,
  // y al final los destacados. Con los otros órdenes va una sola lista.
  grupos = computed(() => {
    const visibles = this.visibles();
    if (this.orden() !== 'recientes') {
      return visibles.length ? [{ titulo: '', filas: visibles.map((p) => this.fila(p)) }] : [];
    }

    const grupos: { titulo: string; filas: Fila[] }[] = [];
    const agregar = (titulo: string, punto: Punto) => {
      let grupo = grupos.find((g) => g.titulo === titulo);
      if (!grupo) {
        grupo = { titulo, filas: [] };
        grupos.push(grupo);
      }
      grupo.filas.push(this.fila(punto));
    };
    visibles.filter((p) => p.origen === 'propio').forEach((p) => agregar(this.nombreDelDia(p.fecha), p));
    visibles
      .filter((p) => p.origen === 'destacado')
      .sort((a, b) => this.porNombre(a, b))
      .forEach((p) => agregar('Destacados de Bogotá', p));
    visibles
      .filter((p) => p.origen === 'comunidad')
      .sort((a, b) => b.fecha.localeCompare(a.fecha))
      .forEach((p) => agregar('De la comunidad', p));
    return grupos;
  });

  constructor(
    public datos: PuntosService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.datos.cargar();
  }

  // Deslizar hacia abajo: trae lo nuevo de la comunidad.
  async recargar(evento: Event): Promise<void> {
    await this.datos.sincronizar();
    (evento.target as HTMLIonRefresherElement).complete();
  }

  alBuscar(evento: Event): void {
    this.busqueda.set((evento.target as HTMLInputElement).value);
  }

  alternarCategoria(id: Categoria): void {
    const elegidas = this.categoriasElegidas();
    this.categoriasElegidas.set(
      elegidas.includes(id) ? elegidas.filter((c) => c !== id) : [...elegidas, id]
    );
  }

  limpiarFiltros(): void {
    this.filtroOrigen.set('todos');
    this.categoriasElegidas.set([]);
    this.soloFavoritos.set(false);
    this.ocultarArreglados.set(false);
  }

  // Abre el punto en la pestaña del mapa.
  abrir(id: number): void {
    this.datos.puntoParaAbrir.set(id);
    this.router.navigate(['/tabs/tab1']);
  }

  private fila(punto: Punto): Fila {
    const categoria = this.datos.categoria(punto.categoria);
    const titulo = this.datos.titulo(punto);
    const yo = this.datos.miUbicacion();
    return {
      id: punto.id,
      titulo,
      subtitulo: this.subtitulo(punto, titulo, categoria.nombre),
      foto: punto.fotos[0] ?? null,
      icono: categoria.icono,
      distancia: yo ? this.datos.formatoDistancia(this.datos.distancia(yo, punto)) : null,
      favorito: punto.favorito,
      estadoReporte: punto.categoria !== 'reporte' ? null : punto.resuelto ? 'arreglado' : 'pendiente',
    };
  }

  // Segunda línea de la fila, evitando repetir lo que ya dice el título.
  private subtitulo(punto: Punto, titulo: string, categoria: string): string {
    if (titulo === categoria) {
      return punto.nota || this.datos.textoCoordenadas(punto);
    }
    return punto.nombre && punto.direccion ? `${categoria} · ${punto.direccion}` : categoria;
  }

  private porNombre(a: Punto, b: Punto): number {
    return this.datos.titulo(a).localeCompare(this.datos.titulo(b), 'es');
  }

  private nombreDelDia(fechaIso: string): string {
    const fecha = new Date(fechaIso);
    const hoy = new Date();
    const ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);
    if (fecha.toDateString() === hoy.toDateString()) {
      return 'Agregados hoy';
    }
    if (fecha.toDateString() === ayer.toDateString()) {
      return 'Agregados ayer';
    }
    return fecha.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  }
}
