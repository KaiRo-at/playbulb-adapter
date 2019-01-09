/**
 * playbulb-adapter.js - MiPow Playbulb adapter.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */

'use strict';

let Adapter, Device, Property;
try {
  Adapter = require('../adapter');
  Device = require('../device');
  Property = require('../property');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Adapter = gwa.Adapter;
  Device = gwa.Device;
  Property = gwa.Property;
}
const noble = require('noble');

class PlaybulbProperty extends Property {
  constructor(device, name, propertyDescription) {
    super(device, name, propertyDescription);
    this.setCachedValue(propertyDescription.value);
    this.device.notifyPropertyChanged(this);
  }

  /**
   * Set the value of the property.
   *
   * @param {*} value The new value to set
   * @returns a promise which resolves to the updated value.
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    return new Promise((resolve, reject) => {
      super.setValue(value).then((updatedValue) => {
        resolve(updatedValue);
        this.device.notifyPropertyChanged(this);
      }).catch((err) => {
        reject(err);
      });
    });
  }
}

class PlaybulbDevice extends Device {
  constructor(adapter, id, deviceDescription) {
    super(adapter, id);
    this.name = deviceDescription.name;
    this.type = deviceDescription.type;
    this['@type'] = deviceDescription['@type'];
    this.description = deviceDescription.description;
    for (const propertyName in deviceDescription.properties) {
      const propertyDescription = deviceDescription.properties[propertyName];
      const property = new PlaybulbProperty(this, propertyName,
                                           propertyDescription);
      this.properties.set(propertyName, property);
    }
  }
}

class PlaybulbAdapter extends Adapter {
  constructor(addonManager, packageName) {
    super(addonManager, 'PlaybulbAdapter', packageName);
    addonManager.addAdapter(this);

    // Bind to |this| as they get called on the noble object.
    this.handleStateChange = this._handleStateChange.bind(this);
    this.handleDiscover = this._handleDiscover.bind(this);
    this.handleScanStart = this._handleScanStart.bind(this);
    this.handleScanStop = this._handleScanStop.bind(this);

    // Now we are ready to start discovery.
    noble.on('warning', (e) => console.warn('noble warning:', e));
    this.scanEnabled = false;
    this._startBLEDiscovery();
  }

  /**
   * Start discovering BLE devices.
   */
  _startBLEDiscovery() {
    this.scanEnabled = true;
    noble.on('stateChange', this.handleStateChange);
    noble.on('scanStart', this.handleScanStart);
    noble.on('scanStop', this.handleScanStop);
    noble.on('discover', this.handleDiscover);
    // Only manually start if powered on already. Otherwise, wait for state
    // change and handle it there.
    if (noble._state === 'poweredOn') {
      this._startNobleScanning();
    }
  }

  /**
   * Stop discovering BLE devices.
   */
  _stopBLEDiscovery() {
    this._stopNobleScanning();
    noble.removeListener('stateChange', this.handleStateChange);
    noble.removeListener('scanStart', this.handleScanStart);
    noble.removeListener('scanStop', this.handleScanStop);
    noble.removeListener('discover', this.handleDiscover);
  }

  /**
   * handle scanEnabled flag. Also, note that those functions will be called on the noble object, so we need to bind then to |this| in the constructor.
   * <mrstegeman> those are event callbacks. i found that noble doesn't do well when trying to both scan and communicate with an individual device, so when doing comms, i set a flag.
   * <mrstegeman> so, if a scan was started right before comms start, i just shut down the scan in the callback
   */
  _handleScanStart() {
    if (!this.scanEnabled) {
      this._stopNobleScanning();
    }
  }
  _handleScanStop() {
    if (this.scanEnabled) {
      this._startNobleScanning();
    }
  }

  _handleStateChange(state) {
    if (state === 'poweredOn' && this.scanEnabled) {
      this._startNobleScanning();
    } else {
      this._stopNobleScanning();
    }
  }

  /**
   * We discovered a BLE device! Let's see if it's a Playbulb and add it.
   */
  _handleDiscover(peripheral) {
    if (peripheral.advertisement.localName &&
        peripheral.advertisement.localName.startsWith('PLAYBULB ') &&
        peripheral.advertisement.manufacturerData.toString('hex').startsWith('4d49') &&
        peripheral.connectable) {
      // The localName says it's a Playbulb, the manufacturerData starts with
      // the MiPow identifier, and it's connectable, so we should be good. :)
      console.log('Playbulb device discovered: ' + peripheral.advertisement.localName);
      console.log('    address: ' + peripheral.address +  ', RSSI ' + peripheral.rssi);
      console.log('    manufacturer data: ' + peripheral.advertisement.manufacturerData.toString('hex'));
      console.log('    advertised services: ' + JSON.stringify(peripheral.advertisement.serviceUuids));

      peripheral.connect(function(error) {
        peripheral.discoverServices(null, function(error, services) {
          for (var si in services) {
            var deviceInformationService = services[si];
            console.log('discovered device information service ' + services[si].uuid);

            deviceInformationService.discoverCharacteristics(null, function(error, characteristics) {
              console.log('discovered the following characteristics:');
              for (var ci in characteristics) {
                console.log('  ' + ci + ' uuid: ' + characteristics[ci].uuid);
              }
            });
          }
        });
        peripheral.disconnect();
      });
      console.log();

      // Actually construct and add device.
      var device = new PlaybulbDevice(this, 'playbulb-' + peripheral.address, {
        name: peripheral.advertisement.localName,
        '@type': ['Light'],
        type: 'light',
        description: peripheral.advertisement.localName + ' ' + peripheral.address,
        properties: {
          on: {
            '@type': 'OnOffProperty',
            label: 'On/Off',
            name: 'on',
            type: 'boolean',
            value: false,
          },
          color: {
            '@type': 'ColorProperty',
            label: 'Color',
            name: 'color',
            type: 'string',
            value: '#FFFFFF',
          },
        },
      });
      this.handleDeviceAdded(device);

    }
    else {
      // In production, we want to be silent here. For now, emit debug info.
      console.log('Ignoring non-Playbulb device: ' + peripheral.advertisement.localName + ' (' + peripheral.address +')');
    }
  }

  /**
   * Pure helper function to start noble scanning.
   */
  _startNobleScanning() {
    console.log('Start scanning for Playbulb devices...');
    noble.startScanning();
  }

  /**
   * Pure helper function to stop noble scanning.
   */
  _stopNobleScanning() {
    console.log('Stop scanning for Playbulb devices.');
    noble.stopScanning();
  }

  /**
   * Process to add a new device to the adapter.
   *
   * The important part is to call: `this.handleDeviceAdded(device)`
   *
   * @param {String} deviceId ID of the device to add.
   * @param {String} deviceDescription Description of the device to add.
   * @return {Promise} which resolves to the device added.
   */
  addDevice(deviceId, deviceDescription) {
    return new Promise((resolve, reject) => {
      if (deviceId in this.devices) {
        reject(`Device: ${deviceId} already exists.`);
      } else {
        const device = new PlaybulbDevice(this, deviceId, deviceDescription);
        this.handleDeviceAdded(device);
        resolve(device);
      }
    });
  }

  /**
   * Process to remove a device from the adapter.
   *
   * The important part is to call: `this.handleDeviceRemoved(device)`
   *
   * @param {String} deviceId ID of the device to remove.
   * @return {Promise} which resolves to the device removed.
   */
  removeDevice(deviceId) {
    return new Promise((resolve, reject) => {
      const device = this.devices[deviceId];
      if (device) {
        this.handleDeviceRemoved(device);
        resolve(device);
      } else {
        reject(`Device: ${deviceId} not found.`);
      }
    });
  }

  /**
   * Start the pairing/discovery process.
   *
   * @param {Number} timeoutSeconds Number of seconds to run before timeout
   */
  startPairing(_timeoutSeconds) {
    console.log('PlaybulbAdapter:', this.name,
                'id', this.id, 'pairing started');
    this._startBLEDiscovery();
  }

  /**
   * Cancel the pairing/discovery process.
   */
  cancelPairing() {
    console.log('PlaybulbAdapter:', this.name, 'id', this.id,
                'pairing cancelled');
    this._stopBLEDiscovery();
  }

  /**
   * Unpair the provided the device from the adapter.
   *
   * @param {Object} device Device to unpair with
   */
  removeThing(device) {
    console.log('PlaybulbAdapter:', this.name, 'id', this.id,
                'removeThing(', device.id, ') started');

    this.removeDevice(device.id).then(() => {
      console.log('PlaybulbAdapter: device:', device.id, 'was unpaired.');
    }).catch((err) => {
      console.error('PlaybulbAdapter: unpairing', device.id, 'failed');
      console.error(err);
    });
  }

  /**
   * Cancel unpairing process.
   *
   * @param {Object} device Device that is currently being paired
   */
  cancelRemoveThing(device) {
    console.log('PlaybulbAdapter:', this.name, 'id', this.id,
                'cancelRemoveThing(', device.id, ')');
  }
}

function loadPlaybulbAdapter(addonManager, manifest, _errorCallback) {
  const adapter = new PlaybulbAdapter(addonManager, manifest.name);
}

module.exports = loadPlaybulbAdapter;
