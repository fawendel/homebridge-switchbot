import { interval, Subject } from 'rxjs';
import { skipWhile } from 'rxjs/operators';
import { SwitchBotPlatform } from '../platform';
import { Service, PlatformAccessory, Units, CharacteristicValue } from 'homebridge';
import { DeviceURL, device, devicesConfig, serviceData, ad, switchbot, deviceStatusResponse, temperature, deviceStatus } from '../settings';
import { Context } from 'vm';
import { hostname } from "os";

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class MeterPlus {
  // Services
  batteryService?: Service;
  temperatureservice?: Service;
  humidityservice?: Service;

  // Characteristic Values
  CurrentRelativeHumidity!: CharacteristicValue;
  CurrentRelativeHumidityCached!: CharacteristicValue;
  CurrentTemperature?: CharacteristicValue;
  CurrentTemperatureCached?: CharacteristicValue;
  BatteryLevel?: CharacteristicValue;
  ChargingState?: CharacteristicValue;
  StatusLowBattery?: CharacteristicValue;
  Active!: CharacteristicValue;
  WaterLevel!: CharacteristicValue;

  // OpenAPI Others
  Temperature: deviceStatus['temperature'];
  Humidity: deviceStatus['humidity'];
  deviceStatus!: deviceStatusResponse;

  // BLE Others
  connected?: boolean;
  switchbot!: switchbot;
  SwitchToOpenAPI?: boolean;
  serviceData!: serviceData;
  address!: ad['address'];
  temperature!: temperature['c'];
  battery!: serviceData['battery'];
  humidity!: serviceData['humidity'];

  // Config
  scanDuration!: number;
  deviceLogging!: string;
  deviceRefreshRate!: number;

  // Updates
  meterUpdateInProgress!: boolean;
  doMeterUpdate: Subject<void>;

  // EVE history service handler
  historyService: any;

  constructor(private readonly platform: SwitchBotPlatform, private accessory: PlatformAccessory, public device: device & devicesConfig) {
    // default placeholders
    this.logs(device);
    this.scan(device);
    this.setupHistoryService(device);
    this.refreshRate(device);
    this.config(device);
    if (this.CurrentRelativeHumidity === undefined) {
      this.CurrentRelativeHumidity = 0;
    } else {
      this.CurrentRelativeHumidity = this.accessory.context.CurrentRelativeHumidity;
    }
    if (this.CurrentTemperature === undefined) {
      this.CurrentTemperature = 0;
    } else {
      this.CurrentTemperature = this.accessory.context.CurrentTemperature;
    }

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doMeterUpdate = new Subject();
    this.meterUpdateInProgress = false;

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // set accessory information
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, this.model(device))
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.deviceId!)
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, this.FirmwareRevision(accessory, device))
      .getCharacteristic(this.platform.Characteristic.FirmwareRevision).updateValue(this.FirmwareRevision(accessory, device));

    // Temperature Sensor Service
    if (device.meter?.hide_temperature) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Removing Temperature Sensor Service`);
      this.temperatureservice = this.accessory.getService(this.platform.Service.TemperatureSensor);
      accessory.removeService(this.temperatureservice!);
    } else if (!this.temperatureservice) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Add Temperature Sensor Service`);
      (this.temperatureservice =
        this.accessory.getService(this.platform.Service.TemperatureSensor) || this.accessory.addService(this.platform.Service.TemperatureSensor)),
      `${accessory.displayName} Temperature Sensor`;

      this.temperatureservice.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Temperature Sensor`);

      this.temperatureservice
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .setProps({
          unit: Units['CELSIUS'],
          validValueRanges: [-273.15, 100],
          minValue: -273.15,
          maxValue: 100,
          minStep: 0.1,
        })
        .onGet(() => {
          return this.CurrentTemperature!;
        });
    } else {
      this.debugLog(`Meter Plus: ${accessory.displayName} Temperature Sensor Service Not Added`);
    }

    // Humidity Sensor Service
    if (device.meter?.hide_humidity) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Removing Humidity Sensor Service`);
      this.humidityservice = this.accessory.getService(this.platform.Service.HumiditySensor);
      accessory.removeService(this.humidityservice!);
    } else if (!this.humidityservice) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Add Humidity Sensor Service`);
      (this.humidityservice =
        this.accessory.getService(this.platform.Service.HumiditySensor) || this.accessory.addService(this.platform.Service.HumiditySensor)),
      `${accessory.displayName} Humidity Sensor`;

      this.humidityservice.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Humidity Sensor`);

      this.humidityservice
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .setProps({
          minStep: 0.1,
        })
        .onGet(() => {
          return this.CurrentRelativeHumidity;
        });
    } else {
      this.debugLog(`Meter Plus: ${accessory.displayName} Humidity Sensor Service Not Added`);
    }

    // Battery Service
    if (!device.ble) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Removing Battery Service`);
      this.batteryService = this.accessory.getService(this.platform.Service.Battery);
      accessory.removeService(this.batteryService!);
    } else if (device.ble && !this.batteryService) {
      this.debugLog(`Meter Plus: ${accessory.displayName} Add Battery Service`);
      (this.batteryService = this.accessory.getService(this.platform.Service.Battery) || this.accessory.addService(this.platform.Service.Battery)),
      `${accessory.displayName} Battery`;

      this.batteryService.setCharacteristic(this.platform.Characteristic.Name, `${accessory.displayName} Battery`);

      this.batteryService.setCharacteristic(this.platform.Characteristic.ChargingState, this.platform.Characteristic.ChargingState.NOT_CHARGEABLE);
    } else {
      this.debugLog(`Meter Plus: ${accessory.displayName} Battery Service Not Added`);
    }

    // Retrieve initial values and updateHomekit
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.deviceRefreshRate * 1000)
      .pipe(skipWhile(() => this.meterUpdateInProgress))
      .subscribe(async () => {
        await this.refreshStatus();
      });
  }

  /**
   * Parse the device status from the SwitchBot api
   */
  async parseStatus(): Promise<void> {
    if (this.SwitchToOpenAPI || !this.device.ble) {
      await this.openAPIparseStatus();
    } else {
      await this.BLEparseStatus();
    }
  }

  async BLEparseStatus(): Promise<void> {
    this.debugLog(`Meter Plus: ${this.accessory.displayName} BLE parseStatus`);

    // Battery
    this.BatteryLevel = Number(this.battery);
    if (this.BatteryLevel < 15) {
      this.StatusLowBattery = this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      this.StatusLowBattery = this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
    this.debugLog(`${this.accessory.displayName} BatteryLevel: ${this.BatteryLevel}, StatusLowBattery: ${this.StatusLowBattery}`);

    // Humidity
    if (!this.device.meter?.hide_humidity) {
      this.CurrentRelativeHumidity = this.humidity!;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Humidity: ${this.CurrentRelativeHumidity}%`);
    }

    // Current Temperature
    if (!this.device.meter?.hide_temperature) {
      this.temperature < 0 ? 0 : this.temperature > 100 ? 100 : this.temperature;
      this.CurrentTemperature = this.temperature;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Temperature: ${this.CurrentTemperature}°c`);
    }
  }

  async openAPIparseStatus(): Promise<void> {
    if (this.device.ble) {
      this.SwitchToOpenAPI = false;
    }
    if (this.platform.config.credentials?.openToken) {
      this.debugLog(`Meter Plus: ${this.accessory.displayName} OpenAPI parseStatus`);
      // Current Relative Humidity
      if (!this.device.meter?.hide_humidity) {
        this.CurrentRelativeHumidity = this.Humidity!;
        this.debugLog(`Meter Plus: ${this.accessory.displayName} Humidity: ${this.CurrentRelativeHumidity}%`);
      }

      // Current Temperature
      if (!this.device.meter?.hide_temperature) {
        this.CurrentTemperature = this.Temperature!;
        this.debugLog(`Meter Plus: ${this.accessory.displayName} Temperature: ${this.CurrentTemperature}°c`);
      }
    }
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus(): Promise<void> {
    if (this.device.ble) {
      this.BLErefreshStatus();
    } else {
      this.openAPIRefreshStatus();
    }
  }

  async BLErefreshStatus(): Promise<void> {
    this.debugLog(`Meter Plus: ${this.accessory.displayName} BLE RefreshStatus`);
    const switchbot = await this.platform.connectBLE();
    // Convert to BLE Address
    this.device.bleMac = this.device
      .deviceId!.match(/.{1,2}/g)!
      .join(':')
      .toLowerCase();
    this.debugLog(`Meter Plus: ${this.accessory.displayName} BLE Address: ${this.device.bleMac}`);
    this.getCustomBLEAddress(switchbot);
    // Start to monitor advertisement packets
    if (switchbot !== false) {
      switchbot
        .startScan({
          model: 'i',
          id: this.device.bleMac,
        })
        .then(() => {
          // Set an event hander
          switchbot.onadvertisement = (ad: ad) => {
            this.address = ad.address;
            if (this.deviceLogging.includes('debug')) {
              this.infoLog(this.address);
              this.infoLog(this.device.bleMac);
              this.infoLog(`Meter Plus: ${this.accessory.displayName} BLE Address Found: ${this.address}`);
              this.infoLog(`Meter Plus: ${this.accessory.displayName} Config BLE Address: ${this.device.bleMac}`);
            }
            this.serviceData = ad.serviceData;
            this.temperature = ad.serviceData.temperature!.c;
            this.humidity = ad.serviceData.humidity;
            this.battery = ad.serviceData.battery;
            this.debugLog(`Meter Plus: ${this.accessory.displayName} serviceData: ${JSON.stringify(ad.serviceData)}`);
            this.debugLog(
              `Meter Plus: ${this.accessory.displayName} model: ${ad.serviceData.model}, modelName: ${ad.serviceData.modelName}, ` +
                `temperature: ${JSON.stringify(ad.serviceData.temperature?.c)}, humidity: ${ad.serviceData.humidity}, ` +
                `battery: ${ad.serviceData.battery}`,
            );

            if (this.serviceData) {
              this.connected = true;
              this.debugLog(`Meter Plus: ${this.accessory.displayName} connected: ${this.connected}`);
            } else {
              this.connected = false;
              this.debugLog(`Meter Plus: ${this.accessory.displayName} connected: ${this.connected}`);
            }
          };
          // Wait 10 seconds
          return switchbot.wait(this.scanDuration * 1000);
        })
        .then(async () => {
          // Stop to monitor
          switchbot.stopScan();
          if (this.connected) {
            this.parseStatus();
            this.updateHomeKitCharacteristics();
          } else {
            await this.BLEconnection(switchbot);
          }
        })
        .catch(async (e: any) => {
          this.errorLog(`Meter Plus: ${this.accessory.displayName} failed refreshStatus with BLE Connection`);
          if (this.deviceLogging.includes('debug')) {
            this.errorLog(
              `Meter Plus: ${this.accessory.displayName} failed refreshStatus with BLE Connection,` + ` Error Message: ${JSON.stringify(e.message)}`,
            );
          }
          if (this.platform.config.credentials?.openToken) {
            this.warnLog(`Meter Plus: ${this.accessory.displayName} Using OpenAPI Connection`);
            this.SwitchToOpenAPI = true;
            this.openAPIRefreshStatus();
          }
          this.apiError(e);
        });
    } else {
      await this.BLEconnection(switchbot);
    }
  }

  async getCustomBLEAddress(switchbot: any) {
    if (this.device.customBLEaddress && this.deviceLogging.includes('debug')) {
      (async () => {
        // Start to monitor advertisement packets
        await switchbot.startScan({
          model: 'i',
        });
        // Set an event handler
        switchbot.onadvertisement = (ad: any) => {
          this.warnLog(JSON.stringify(ad, null, '  '));
        };
        await switchbot.wait(10000);
        // Stop to monitor
        switchbot.stopScan();
      })();
    }
  }

  async BLEconnection(switchbot: any): Promise<void> {
    this.errorLog(`Meter Plus: ${this.accessory.displayName} wasn't able to establish BLE Connection, node-switchbot: ${switchbot}`);
    if (this.platform.config.credentials?.openToken) {
      this.warnLog(`Meter Plus: ${this.accessory.displayName} Using OpenAPI Connection`);
      this.SwitchToOpenAPI = true;
      await this.openAPIRefreshStatus();
    }
  }

  async openAPIRefreshStatus(): Promise<void> {
    if (this.platform.config.credentials?.openToken) {
      this.debugLog(`Meter Plus: ${this.accessory.displayName} OpenAPI RefreshStatus`);
      try {
        this.deviceStatus = (await this.platform.axios.get(`${DeviceURL}/${this.device.deviceId}/status`)).data;
        this.debugLog(`Meter Plus: ${this.accessory.displayName} openAPIRefreshStatus: ${JSON.stringify(this.deviceStatus)}`);
        this.Humidity = this.deviceStatus.body.humidity!;
        this.Temperature = this.deviceStatus.body.temperature!;
        this.parseStatus();
        this.updateHomeKitCharacteristics();
      } catch (e: any) {
        this.errorLog(`Meter Plus: ${this.accessory.displayName} failed refreshStatus with OpenAPI Connection`);
        if (this.deviceLogging.includes('debug')) {
          this.errorLog(
            `Meter Plus: ${this.accessory.displayName} failed refreshStatus with OpenAPI Connection,` +
              ` Error Message: ${JSON.stringify(e.message)}`,
          );
        }
        this.apiError(e);
      }
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  async updateHomeKitCharacteristics(): Promise<void> {
    let entry = {time: Math.round(new Date().valueOf()/1000)};
    if (!this.device.meter?.hide_humidity) {
      if (this.CurrentRelativeHumidity === undefined) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} CurrentRelativeHumidity: ${this.CurrentRelativeHumidity}`);
      } else {
        this.humidityservice?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.CurrentRelativeHumidity);
        this.debugLog(`Meter Plus: ${this.accessory.displayName} updateCharacteristic CurrentRelativeHumidity: ${this.CurrentRelativeHumidity}`);
        entry["humidity"] = this.CurrentRelativeHumidity;
      }
    }
    if (!this.device.meter?.hide_temperature) {
      if (this.CurrentTemperature === undefined) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} CurrentTemperature: ${this.CurrentTemperature}`);
      } else {
        this.temperatureservice?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.CurrentTemperature);
        this.debugLog(`Meter Plus: ${this.accessory.displayName} updateCharacteristic CurrentTemperature: ${this.CurrentTemperature}`);
      	entry["temp"] = this.CurrentTemperature;
      }
    }
    if (this.device.ble) {
      if (this.BatteryLevel === undefined) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} BatteryLevel: ${this.BatteryLevel}`);
      } else {
        this.batteryService?.updateCharacteristic(this.platform.Characteristic.BatteryLevel, this.BatteryLevel);
        this.debugLog(`Meter Plus: ${this.accessory.displayName} updateCharacteristic BatteryLevel: ${this.BatteryLevel}`);
      }
      if (this.StatusLowBattery === undefined) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} StatusLowBattery: ${this.StatusLowBattery}`);
      } else {
        this.batteryService?.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, this.StatusLowBattery);
        this.debugLog(`Meter Plus: ${this.accessory.displayName} updateCharacteristic StatusLowBattery: ${this.StatusLowBattery}`);
      }
    }
        if (this.CurrentRelativeHumidity > 0) { // reject unreliable data
      this.historyService?.addEntry(entry);
    }
  }

  async apiError(e: any): Promise<void> {
    if (!this.device.meter?.hide_humidity) {
      this.humidityservice?.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, e);
    }
    if (!this.device.meter?.hide_temperature) {
      this.temperatureservice?.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, e);
    }
    if (this.device.ble) {
      this.batteryService?.updateCharacteristic(this.platform.Characteristic.BatteryLevel, e);
      this.batteryService?.updateCharacteristic(this.platform.Characteristic.StatusLowBattery, e);
    }
    //throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  model(device: device & devicesConfig): CharacteristicValue {
    let model: string;
    if (device.deviceType === 'Meter Plus (JP)') {
      model = 'W2201500';
    } else {
      model = 'W2301500';
    }
    return model;
  }

  async config(device: device & devicesConfig): Promise<void> {
    let config = {};
    if (device.meter) {
      config = device.meter;
    }
    if (device.ble !== undefined) {
      config['ble'] = device.ble;
    }
    if (device.logging !== undefined) {
      config['logging'] = device.logging;
    }
    if (device.refreshRate !== undefined) {
      config['refreshRate'] = device.refreshRate;
    }
    if (device.scanDuration !== undefined) {
      config['scanDuration'] = device.scanDuration;
    }
    if (Object.entries(config).length !== 0) {
      this.infoLog(`Meter Plus: ${this.accessory.displayName} Config: ${JSON.stringify(config)}`);
    }
  }

  async refreshRate(device: device & devicesConfig): Promise<void> {
    if (device.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = device.refreshRate;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Device Config refreshRate: ${this.deviceRefreshRate}`);
    } else if (this.platform.config.options!.refreshRate) {
      this.deviceRefreshRate = this.accessory.context.refreshRate = this.platform.config.options!.refreshRate;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Platform Config refreshRate: ${this.deviceRefreshRate}`);
    }
  }

  async scan(device: device & devicesConfig): Promise<void> {
    if (device.scanDuration) {
      this.scanDuration = this.accessory.context.scanDuration = device.scanDuration;
      if (device.ble) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Device Config scanDuration: ${this.scanDuration}`);
      }
    } else {
      this.scanDuration = this.accessory.context.scanDuration = 1;
      if (this.device.ble) {
        this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Default scanDuration: ${this.scanDuration}`);
      }
    }
  }

  async logs(device: device & devicesConfig): Promise<void> {
    if (this.platform.debugMode) {
      this.deviceLogging = this.accessory.context.logging = 'debugMode';
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Debug Mode Logging: ${this.deviceLogging}`);
    } else if (device.logging) {
      this.deviceLogging = this.accessory.context.logging = device.logging;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Device Config Logging: ${this.deviceLogging}`);
    } else if (this.platform.config.options?.logging) {
      this.deviceLogging = this.accessory.context.logging = this.platform.config.options?.logging;
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Using Platform Config Logging: ${this.deviceLogging}`);
    } else {
      this.deviceLogging = this.accessory.context.logging = 'standard';
      this.debugLog(`Meter Plus: ${this.accessory.displayName} Logging Not Set, Using: ${this.deviceLogging}`);
    }
  }

    /*
   * Setup EVE history graph feature if enabled.
   */
    async setupHistoryService(device: device & devicesConfig): Promise<void> {
      const mac = this.device.deviceId!.match(/.{1,2}/g)!.join(':').toLowerCase();
      this.historyService = device.history ?
      new this.platform.fakegatoAPI('room', this.accessory,
        {log: this.platform.log, storage: 'fs',
         filename: `${hostname().split(".")[0]}_${mac}_persist.json`
        }) :
      null;
    }

  FirmwareRevision(accessory: PlatformAccessory<Context>, device: device & devicesConfig): CharacteristicValue {
    let FirmwareRevision: string;
    this.debugLog(`Color Bulb: ${this.accessory.displayName} accessory.context.FirmwareRevision: ${accessory.context.FirmwareRevision}`);
    this.debugLog(`Color Bulb: ${this.accessory.displayName} device.firmware: ${device.firmware}`);
    this.debugLog(`Color Bulb: ${this.accessory.displayName} this.platform.version: ${this.platform.version}`);
    if (accessory.context.FirmwareRevision) {
      FirmwareRevision = accessory.context.FirmwareRevision;
    } else if (device.firmware) {
      FirmwareRevision = device.firmware;
    } else {
      FirmwareRevision = this.platform.version;
    }
    return FirmwareRevision;
  }

  /**
   * Logging for Device
   */
  infoLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.info(String(...log));
    }
  }

  warnLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.warn(String(...log));
    }
  }

  errorLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      this.platform.log.error(String(...log));
    }
  }

  debugLog(...log: any[]): void {
    if (this.enablingDeviceLogging()) {
      if (this.deviceLogging === 'debug') {
        this.platform.log.info('[DEBUG]', String(...log));
      } else {
        this.platform.log.debug(String(...log));
      }
    }
  }

  enablingDeviceLogging(): boolean {
    return this.deviceLogging.includes('debug') || this.deviceLogging === 'standard';
  }
}
