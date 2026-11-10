import { Component } from '@angular/core';
import { AlertasService } from '../alertas.service';

@Component({
  selector: 'app-tabs',
  templateUrl: 'tabs.page.html',
  styleUrls: ['tabs.page.scss'],
  standalone: false,
})
export class TabsPage {
  // Para mostrar en la pestaña cuántos recordatorios hay programados.
  constructor(public alertas: AlertasService) {}
}
