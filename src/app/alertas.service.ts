import { Injectable, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  LocalNotifications,
  LocalNotificationSchema,
  PendingLocalNotificationSchema,
  PermissionStatus,
} from '@capacitor/local-notifications';
import { Coordenada, Punto, PuntosService } from './puntos.service';

// Basado en el servicio de notificaciones locales visto en clase, adaptado a Rolo.

export type PermisoAlertas = PermissionStatus['display']; // 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied'

// 'visita': recordarme visitar un lugar. 'seguimiento': revisar si ya arreglaron un reporte.
export type TipoRecordatorio = 'visita' | 'seguimiento';

export interface Recordatorio {
  id: number;
  puntoId: number;
  tipo: TipoRecordatorio;
  fecha: Date;
}

export interface AjustesAlertas {
  // Avisar al acercarse a huecos o daños reportados.
  reportes: boolean;
  // Avisar al acercarse a lugares favoritos.
  favoritos: boolean;
}

const CANAL_RECORDATORIOS = 'rolo-recordatorios';
const CANAL_CERCANIA = 'rolo-cercania';
const ACCIONES = 'ROLO_PUNTO';
const STORAGE_AJUSTES = 'alertas_ajustes';
// Color del ícono de la notificación en Android: el rojo de Rolo.
const COLOR = '#C8102E';
// Silueta blanca de la R de Rolo (android/app/src/main/res/drawable-*/ic_stat_rolo.png).
const ICONO = 'ic_stat_rolo';

export const RADIO_REPORTES = 150; // metros
export const RADIO_FAVORITOS = 300; // metros
// Para no repetir el mismo aviso de cercanía a cada paso.
const ESPERA_ENTRE_AVISOS = 30 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class AlertasService {
  readonly permiso = signal<PermisoAlertas>('prompt');
  readonly pendientes = signal<PendingLocalNotificationSchema[]>([]);
  readonly ajustes = signal<AjustesAlertas>({ reportes: true, favoritos: true });

  readonly activadas = computed(() => this.permiso() === 'granted');

  // Recordatorios programados, del más próximo al más lejano.
  readonly recordatorios = computed<Recordatorio[]>(() =>
    this.pendientes()
      .filter((n) => typeof n.extra?.puntoId === 'number' && n.schedule?.at)
      .map((n) => ({
        id: n.id,
        puntoId: n.extra.puntoId,
        tipo: (n.extra.tipo ?? 'visita') as TipoRecordatorio,
        fecha: new Date(n.schedule!.at as any),
      }))
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
  );

  private iniciado = false;
  private ultimosAvisos = new Map<number, number>();
  // Los ids deben caber en un entero de 32 bits (Java).
  private secuencia = Math.floor(Date.now() / 1000) % 1_000_000_000;

  constructor(
    private datos: PuntosService,
    private router: Router
  ) {}

  /** Se llama una vez al arrancar la app (en AppComponent). */
  async iniciar(): Promise<void> {
    if (this.iniciado) {
      return;
    }
    this.iniciado = true;

    const { value } = await Preferences.get({ key: STORAGE_AJUSTES });
    if (value) {
      this.ajustes.set({ ...this.ajustes(), ...JSON.parse(value) });
    }

    try {
      if (Capacitor.getPlatform() === 'android') {
        // Android 8+: las notificaciones necesitan un canal.
        await LocalNotifications.createChannel({
          id: CANAL_RECORDATORIOS,
          name: 'Recordatorios',
          description: 'Recordatorios para visitar lugares y revisar reportes',
          importance: 4,
          visibility: 1,
          vibration: true,
        });
        await LocalNotifications.createChannel({
          id: CANAL_CERCANIA,
          name: 'Avisos de cercanía',
          description: 'Huecos reportados y favoritos cerca de ti',
          importance: 4,
          visibility: 1,
          vibration: true,
        });
      }

      if (Capacitor.isNativePlatform()) {
        // Botones dentro de la notificación.
        await LocalNotifications.registerActionTypes({
          types: [
            {
              id: ACCIONES,
              actions: [
                { id: 'ver', title: 'Ver en el mapa', foreground: true },
                { id: 'posponer', title: 'En 1 hora' },
              ],
            },
          ],
        });
      }

      await LocalNotifications.addListener('localNotificationReceived', () => this.actualizarPendientes());
      await LocalNotifications.addListener('localNotificationActionPerformed', (accion) => {
        const n = accion.notification;
        if (accion.actionId === 'posponer' && typeof n.extra?.puntoId === 'number') {
          this.programarNotificacion({ ...n, id: this.nuevoId() }, new Date(Date.now() + 60 * 60 * 1000));
        } else if (typeof n.extra?.puntoId === 'number') {
          // Al tocar la notificación (o "Ver en el mapa") se abre ese punto.
          this.datos.puntoParaAbrir.set(n.extra.puntoId);
          this.router.navigate(['/tabs/tab1']);
        }
        this.actualizarPendientes();
      });

      const estado = await LocalNotifications.checkPermissions();
      this.permiso.set(estado.display);
    } catch (error) {
      console.error('No se pudieron preparar las notificaciones', error);
    }
    await this.actualizarPendientes();
  }

  async pedirPermiso(): Promise<boolean> {
    try {
      const estado = await LocalNotifications.requestPermissions();
      this.permiso.set(estado.display);
      return estado.display === 'granted';
    } catch {
      return false;
    }
  }

  async cambiarAjustes(cambios: Partial<AjustesAlertas>): Promise<void> {
    this.ajustes.set({ ...this.ajustes(), ...cambios });
    await Preferences.set({ key: STORAGE_AJUSTES, value: JSON.stringify(this.ajustes()) });
  }

  // -------------------------------------------------------------------------
  // Recordatorios programados
  // -------------------------------------------------------------------------

  async programarRecordatorio(punto: Punto, fecha: Date, tipo: TipoRecordatorio): Promise<boolean> {
    if (!(await this.asegurarPermiso())) {
      return false;
    }
    // Un solo recordatorio por punto: el nuevo reemplaza al anterior.
    await this.cancelarDePunto(punto.id);

    const nombre = this.datos.titulo(punto);
    const notificacion: LocalNotificationSchema = {
      id: this.nuevoId(),
      title: tipo === 'visita' ? `Hora de visitar ${nombre}` : `¿Ya arreglaron "${nombre}"?`,
      body:
        tipo === 'visita'
          ? punto.direccion || 'Toca para ver el lugar en el mapa.'
          : 'Pasa a revisar el reporte y actualízalo si ya está arreglado.',
      channelId: CANAL_RECORDATORIOS,
      extra: { puntoId: punto.id, tipo },
    };
    return this.programarNotificacion(notificacion, fecha);
  }

  recordatorioDe(puntoId: number): Recordatorio | null {
    return this.recordatorios().find((r) => r.puntoId === puntoId) ?? null;
  }

  async cancelar(id: number): Promise<void> {
    try {
      await LocalNotifications.cancel({ notifications: [{ id }] });
    } catch {
      // En la web algunas funciones no existen; no es grave.
    }
    await this.actualizarPendientes();
  }

  async cancelarDePunto(puntoId: number): Promise<void> {
    const existente = this.recordatorioDe(puntoId);
    if (existente) {
      await this.cancelar(existente.id);
    }
  }

  // -------------------------------------------------------------------------
  // Avisos de cercanía (mientras la app está abierta)
  // -------------------------------------------------------------------------

  async revisarCercania(yo: Coordenada): Promise<void> {
    const ajustes = this.ajustes();
    if (!this.activadas() || (!ajustes.reportes && !ajustes.favoritos)) {
      return;
    }

    const ahora = Date.now();
    let elegido: { punto: Punto; metros: number } | null = null;
    for (const punto of this.datos.puntos()) {
      const esReporte = ajustes.reportes && punto.categoria === 'reporte' && !punto.resuelto;
      const esFavorito = ajustes.favoritos && punto.favorito;
      if (!esReporte && !esFavorito) {
        continue;
      }
      const metros = this.datos.distancia(yo, punto);
      const radio = esReporte ? RADIO_REPORTES : RADIO_FAVORITOS;
      const ultimo = this.ultimosAvisos.get(punto.id) ?? 0;
      if (metros <= radio && ahora - ultimo > ESPERA_ENTRE_AVISOS && (!elegido || metros < elegido.metros)) {
        elegido = { punto, metros };
      }
    }
    if (!elegido) {
      return;
    }

    const { punto, metros } = elegido;
    this.ultimosAvisos.set(punto.id, ahora);
    const nombre = this.datos.titulo(punto);
    const distancia = this.datos.formatoDistancia(metros);
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: this.nuevoId(),
            title: punto.categoria === 'reporte' ? `Cuidado: ${nombre} a ${distancia}` : `Estás cerca de ${nombre}`,
            body:
              punto.categoria === 'reporte'
                ? 'Hay un hueco o daño reportado en tu camino.'
                : `Uno de tus favoritos está a ${distancia}.`,
            channelId: CANAL_CERCANIA,
            actionTypeId: ACCIONES,
            iconColor: COLOR,
            smallIcon: ICONO,
            isExactNotification: false,
            extra: { puntoId: punto.id },
          },
        ],
      });
    } catch (error) {
      console.error('No se pudo mostrar el aviso de cercanía', error);
    }
  }

  // -------------------------------------------------------------------------
  // Privados
  // -------------------------------------------------------------------------

  private async programarNotificacion(n: LocalNotificationSchema, fecha: Date): Promise<boolean> {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            ...n,
            actionTypeId: ACCIONES,
            iconColor: COLOR,
            smallIcon: ICONO,
            // Los recordatorios no necesitan exactitud al segundo; así Android no
            // le pide al usuario el permiso especial de "alarmas exactas".
            isExactNotification: false,
            schedule: { at: fecha, allowWhileIdle: true },
          },
        ],
      });
      await this.actualizarPendientes();
      return true;
    } catch (error) {
      console.error('No se pudo programar la notificación', error);
      return false;
    }
  }

  private async actualizarPendientes(): Promise<void> {
    try {
      const { notifications } = await LocalNotifications.getPending();
      // Copia nueva: en la web el plugin devuelve siempre el mismo arreglo.
      this.pendientes.set([...notifications]);
    } catch {
      this.pendientes.set([]);
    }
  }

  private async asegurarPermiso(): Promise<boolean> {
    return this.activadas() || (await this.pedirPermiso());
  }

  private nuevoId(): number {
    return ++this.secuencia;
  }
}
