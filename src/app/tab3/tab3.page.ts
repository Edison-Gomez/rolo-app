import { Component, computed } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/lazy';
import { AlertasService, RADIO_FAVORITOS, RADIO_REPORTES } from '../alertas.service';
import { PuntosService } from '../puntos.service';
import { Tema, TemaService } from '../tema.service';

@Component({
  selector: 'app-tab3',
  templateUrl: 'tab3.page.html',
  styleUrls: ['tab3.page.scss'],
  standalone: false,
})
export class Tab3Page {
  readonly radioReportes = RADIO_REPORTES;
  readonly radioFavoritos = RADIO_FAVORITOS;
  readonly temas: { id: Tema; nombre: string; icono: string }[] = [
    { id: 'auto', nombre: 'Automático', icono: 'phone-portrait-outline' },
    { id: 'claro', nombre: 'Claro', icono: 'sunny-outline' },
    { id: 'oscuro', nombre: 'Oscuro', icono: 'moon-outline' },
  ];

  // Recordatorios con los datos del punto, listos para mostrar.
  filas = computed(() =>
    this.alertas.recordatorios().map((r) => {
      const punto = this.datos.puntos().find((p) => p.id === r.puntoId);
      return {
        ...r,
        titulo: punto ? this.datos.titulo(punto) : 'Lugar eliminado',
        foto: punto?.fotos[0] ?? null,
        icono: punto ? this.datos.categoria(punto.categoria).icono : 'location-outline',
        cuando: this.textoFecha(r.fecha),
      };
    })
  );

  cantidadReportes = computed(
    () => this.datos.puntos().filter((p) => p.categoria === 'reporte' && !p.resuelto).length
  );
  cantidadFavoritos = computed(() => this.datos.puntos().filter((p) => p.favorito).length);

  constructor(
    public alertas: AlertasService,
    public datos: PuntosService,
    public tema: TemaService,
    private router: Router,
    private toasts: ToastController
  ) {}

  async activar(): Promise<void> {
    if (!(await this.alertas.pedirPermiso())) {
      this.avisar('Las notificaciones están bloqueadas. Actívalas en los ajustes del teléfono.');
    }
  }

  abrir(puntoId: number): void {
    this.datos.puntoParaAbrir.set(puntoId);
    this.router.navigate(['/tabs/tab1']);
  }

  private textoFecha(fecha: Date): string {
    const hoy = new Date();
    const manana = new Date();
    manana.setDate(hoy.getDate() + 1);
    const hora = fecha.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
    if (fecha.toDateString() === hoy.toDateString()) {
      return `Hoy, ${hora}`;
    }
    if (fecha.toDateString() === manana.toDateString()) {
      return `Mañana, ${hora}`;
    }
    return `${fecha.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'short' })}, ${hora}`;
  }

  private async avisar(mensaje: string): Promise<void> {
    const toast = await this.toasts.create({ message: mensaje, duration: 2600, position: 'top' });
    await toast.present();
  }
}
