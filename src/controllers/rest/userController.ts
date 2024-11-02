/**
 * @author DiZed Team
 * @copyright Copyright (c) DiZed Team (https://github.com/di-zed/)
 */
import { NextFunction, Request, Response } from 'express';
import { DevicesResponse } from '../../devices/response';
import configProvider from '../../providers/configProvider';
import mqttProvider from '../../providers/mqttProvider';
import deviceRepository from '../../repositories/deviceRepository';
import mqttRepository, { CommandTopicData, MqttInputTopicNames, MqttOutputTopicNames } from '../../repositories/mqttRepository';
import deviceHelper from '../../helpers/deviceHelper';
import { Device } from '../../devices/device';
import { Capability, CapabilityState, CapabilityStateActionResult } from '../../devices/capability';
import { Property } from '../../devices/property';
import { RangeCapabilityState } from '../../devices/capabilities/rangeCapability';
import AppError from '../../errors/appError';

/**
 * REST User Controller.
 */
export default class RestUserController {
  /**
   * POST Method.
   * Notification of unlinked accounts.
   * https://yandex.ru/dev/dialogs/smart-home/doc/reference/unlink.html?lang=en
   *
   * @param req
   * @param res
   * @returns Response
   */
  public async unlink(req: Request, res: Response): Promise<Response> {
    console.log(
      res.__(
        "The user's provider account (#%s) and Yandex account (#%s) were unlinked (the link between them was deleted by the user).",
        String(req.currentUser.id),
        String(req.currentClient.id),
      ),
    );

    const callbackRestUserUnlinkAction = configProvider.getConfigOption('callbackRestUserUnlinkAction');
    if (typeof callbackRestUserUnlinkAction === 'function') {
      await callbackRestUserUnlinkAction(req, res);
    }

    return res.status(200).json({
      request_id: req.requestId,
    });
  }

  /**
   * GET Method.
   * Information about user devices.
   * https://yandex.ru/dev/dialogs/smart-home/doc/reference/get-devices.html?lang=en
   *
   * @param req
   * @param res
   * @returns Response
   */
  public async devices(req: Request, res: Response): Promise<Response> {
    const devices: Device[] = await deviceRepository.getUserDevices(req.currentUser.id);

    const response: DevicesResponse = {
      request_id: req.requestId,
      payload: {
        user_id: String(req.currentUser.id),
        devices: JSON.parse(JSON.stringify(devices)),
      },
    };

    response.payload.devices.forEach((device: Device): void => {
      device.capabilities?.forEach((capability: Capability): void => {
        delete capability.state;
      });
      device.properties?.forEach((property: Property): void => {
        delete property.state;
      });
    });

    return res.status(200).json(response);
  }

  /**
   * POST Method.
   * Information about the states of user devices.
   * https://yandex.ru/dev/dialogs/smart-home/doc/reference/post-devices-query.html?lang=en
   *
   * @param req
   * @param res
   * @param next
   * @returns Response
   */
  public async devicesQuery(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    if (typeof req.body.devices !== 'object') {
      return next(new AppError(res.__('The parameter "%s" is required.', 'devices'), 400));
    }

    const response: DevicesResponse = {
      request_id: req.requestId,
      payload: {
        devices: JSON.parse(JSON.stringify(req.body.devices)),
      },
    };

    for (const payloadDevice of <Device[]>response.payload.devices) {
      const userDevice: Device | undefined = await deviceRepository.getUserDeviceById(req.currentUser.id, payloadDevice.id);
      if (userDevice === undefined) {
        payloadDevice.error_code = 'DEVICE_NOT_FOUND';
        payloadDevice.error_message = res.__('The device "%s" can not be found.', payloadDevice.id);
        continue;
      }

      const updatedDevice: Device = await deviceHelper.updateUserDevice(req.currentUser, userDevice, true);

      payloadDevice.capabilities = [];
      for (const capability of updatedDevice.capabilities || []) {
        payloadDevice.capabilities.push(<Capability>{
          type: capability.type,
          state: capability.state,
        });
      }

      payloadDevice.properties = [];
      for (const property of updatedDevice.properties || []) {
        payloadDevice.properties.push(<Property>{
          type: property.type,
          state: property.state,
        });
      }
    }

    return res.status(200).json(response);
  }

  /**
   * POST Method.
   * Change device state.
   * https://yandex.ru/dev/dialogs/smart-home/doc/reference/post-action.html?lang=en
   *
   * @param req
   * @param res
   * @param next
   * @returns Response | void
   */
  public async devicesAction(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    if (typeof req.body.payload !== 'object' || typeof req.body.payload.devices !== 'object') {
      return next(new AppError(res.__('The parameter "%s" is required.', 'devices'), 400));
    }

    const response: DevicesResponse = {
      request_id: req.requestId,
      payload: {
        devices: JSON.parse(JSON.stringify(req.body.payload.devices)),
      },
    };

    for (const payloadDevice of <Device[]>response.payload.devices) {
      const userDevice: Device | undefined = await deviceRepository.getUserDeviceById(req.currentUser.id, payloadDevice.id);
      if (userDevice === undefined) {
        continue;
      }

      const payloadCapabilities: Capability[] = payloadDevice.capabilities || [];
      const updatedDevice: Device = await deviceHelper.updateUserDevice(req.currentUser, userDevice);

      for (const payloadCapability of payloadCapabilities) {
        const capabilityState: CapabilityState = <CapabilityState>payloadCapability.state;
        const topicNames: MqttOutputTopicNames = await mqttRepository.getTopicNames(<MqttInputTopicNames>{
          user: req.currentUser,
          deviceId: userDevice.id,
          capabilityType: payloadCapability.type,
          capabilityStateInstance: capabilityState.instance,
        });

        let actionResult: CapabilityStateActionResult = {
          status: 'ERROR',
          error_code: 'INVALID_ACTION',
          error_message: res.__('Capability "%s" for the device "%s" can not be changed.', payloadCapability.type, userDevice.id),
        };

        try {
          if (topicNames.commandTopic) {
            let value = capabilityState.value;

            let topicData: CommandTopicData | undefined = undefined;
            if (updatedDevice.type) {
              topicData = await mqttRepository.getCommandTopicData(topicNames.commandTopic, updatedDevice.type, {
                capabilityType: payloadCapability.type,
                capabilityStateInstance: capabilityState.instance,
              });
            }

            if (topicData !== undefined && topicData.capabilityType === 'devices.capabilities.range') {
              const rangeState: RangeCapabilityState = <RangeCapabilityState>JSON.parse(JSON.stringify(capabilityState));
              if (rangeState.relative) {
                const deviceCapability: Capability | undefined = deviceHelper.getDeviceCapability(
                  updatedDevice,
                  payloadCapability.type,
                  capabilityState.instance,
                );
                if (deviceCapability !== undefined) {
                  value += deviceCapability.state?.value || 0;
                }
              }
            }

            await mqttProvider.publish(topicNames.commandTopic, await mqttRepository.convertAliceValueToMqttMessage(value, topicData));

            actionResult = { status: 'DONE' };
          }
        } catch (err) {
          console.log('ERROR! User Devices Action.', { err, actionResult });
        }

        delete capabilityState.value;
        capabilityState.action_result = actionResult;
      }
    }

    return res.status(200).json(response);
  }
}
