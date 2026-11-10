import { Component, signal } from '@angular/core';
import { AlertasService } from './alertas.service';
import { PuntosService } from './puntos.service';
import { TemaService } from './tema.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent {
  // La pantalla de inicio se ve al menos este tiempo, para que no parpadee.
  private static readonly MINIMO_INICIO = 1300;

  inicio = signal(true);
  saliendo = signal(false);

  constructor(datos: PuntosService, alertas: AlertasService, tema: TemaService) {
    tema.iniciar();
    const espera = new Promise((listo) => setTimeout(listo, AppComponent.MINIMO_INICIO));
    Promise.all([datos.cargar(), espera]).finally(() => {
      this.saliendo.set(true);
      setTimeout(() => this.inicio.set(false), 450);
    });
    // Los puntos y las alertas se preparan al abrir la app, para que tocar una
    // notificación lleve directo al punto aunque la app estuviera cerrada.
    datos.cargar();
    alertas.iniciar();
  }
}
