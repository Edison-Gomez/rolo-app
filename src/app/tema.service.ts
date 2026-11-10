import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { StatusBar, Style } from '@capacitor/status-bar';

// 'auto' sigue el modo del teléfono; 'claro' y 'oscuro' lo fijan.
export type Tema = 'auto' | 'claro' | 'oscuro';

const STORAGE_TEMA = 'tema';

@Injectable({ providedIn: 'root' })
export class TemaService {
  readonly tema = signal<Tema>('auto');
  readonly oscuro = signal(false);

  private medio = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  async iniciar(): Promise<void> {
    const { value } = await Preferences.get({ key: STORAGE_TEMA });
    if (value === 'claro' || value === 'oscuro' || value === 'auto') {
      this.tema.set(value);
    }
    this.aplicar();
    // Si está en automático y el teléfono cambia de modo, la app cambia con él.
    this.medio?.addEventListener('change', () => this.aplicar());
  }

  async cambiar(tema: Tema): Promise<void> {
    this.tema.set(tema);
    await Preferences.set({ key: STORAGE_TEMA, value: tema });
    this.aplicar();
  }

  private aplicar(): void {
    const oscuro = this.tema() === 'oscuro' || (this.tema() === 'auto' && !!this.medio?.matches);
    this.oscuro.set(oscuro);
    // Ionic activa su paleta oscura con esta clase; la app le pone encima la de Rolo.
    document.documentElement.classList.toggle('ion-palette-dark', oscuro);
    if (Capacitor.isNativePlatform()) {
      // Íconos de la barra de estado claros sobre fondo oscuro, y al revés.
      StatusBar.setStyle({ style: oscuro ? Style.Dark : Style.Light }).catch(() => {});
    }
  }
}
