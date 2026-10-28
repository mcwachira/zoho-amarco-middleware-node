declare namespace Tremol {
    declare var FP: {
        prototype: FP;
        new(): FP ;
    };
    var FP = function(): void { } as new () => FP;

    /** 
     * Tremol fiscal printer javascript library. Usage: var fp = new Tremol.FP();
     */

    declare interface FP {
        /**
         * Returns the version of the core library
         */
        GetVersionCore(): string;
        /**
         * Returns the version of the generated library
         */
        GetVersionDefinitions(): number;
        /**
         * Returns true if there is a command which is currently in progress
         */
        IsWorking(): boolean;
         /**
         * Returns true if server definitions and generated code are with the same versions
         */
        IsCompatible(): boolean;
         /**
         * Sends command to ZfpLab server
         * @throws {Error}
         */
        do(commandName: string, ...var_args: any): any;
        /**
         * Find device connected on serial port or USB
         */
        ServerFindDevice(): Tremol.FP.DeviceSettings;
        /**
         * Gets Device communication settings
         * @throws {Error}
         */
        ServerGetDeviceSettings(): Tremol.FP.DeviceSettings;
        /**
         * Sets Device serial port communication settings
         * @throws {Error}
         */
        ServerSetDeviceSerialSettings(serialPort: string, baudRate: number, keepPortOpen: boolean);
        /**
         * Sets Device Bluetooth communication settings if ZfpLabServer is running on Android device.
         * @throws {Error}
         */
        ServerSetAndroidBluetoothDeviceSettings(deviceFriendlyName: string);
        /**
         * Sets Device LAN/WIFI communication settings
         * @throws {Error}
         */
        ServerSetDeviceTcpSettings(ip: string, tcpport: number, password?: string);
        /**
         * Enables or disables ZfpLab server log
         */
        ServerSetLog(enable: boolean) : void;
		/**
         * Sets custom client Id, which allows multiple PC instances to work with a single fiscal device simultaneously
         */
		ServerSetCustomClientId(clientId: string);
        /**
         * Gets ZfpLab server settings
         */
        ServerGetSettings() : Tremol.FP.ServerSettings;
        /**
         * Sets ZfpLab server settings
         */
        ServerSetSettings(ip: string, tcpport: number);

        ServerGetClients(): Tremol.FP.ServerClient[];
        /**
         * Removes client from the server.
         */
        ServerRemoveClient(ip: string);
        /**
         * Closes the device connection of the current client
         */
        ServerCloseDeviceConnection();
        /**
         * Removes all clients from the server.
         */
        ServerRemoveAllClients();
    }

    declare enum ServerErrorType {
        OK = 0,
        /** The current library version and the fiscal device firmware is not matching */
        ServMismatchBetweenDefinitionAndFPResult = 9,
        ServDefMissing = 10,
        ServArgDefMissing = 11,
        ServCreateCmdString = 12,
        ServUndefined = 19,
        /** When the server can not connect to the fiscal device */
        ServSockConnectionFailed = 30,
        /** Wrong device ТCP password */
        ServTCPAuth = 31,
        ServWrongTcpConnSettings = 32,
        ServWrongSerialPortConnSettings = 33,
        /** Proccessing of other clients command is taking too long */
        ServWaitOtherClientCmdProcessingTimeOut = 34,
        ServDisconnectOtherClientErr = 35,
        FPException = 40,
        ClientArgDefMissing = 50,
        ClientAttrDefMissing = 51,
        ClientArgValueWrongFormat = 52,
        ClientSettingsNotInitialized = 53,
        ClientInvalidGetFormat = 62,
        ClientInvalidPostFormat = 63,
        ServerAddressNotSet = 100,
        /** Specify server ServerAddress property */
        ServerConnectionError = 101,
        /** Connection from this app to the server is not established */
        ServerResponseMissing = 102,
        ServerResponseError = 103,
        /** The current library version and server definitions version do not match */
        ServerDefsMismatch = 104,
        ClientXMLCanNotParse = 105,
        PaymentNotSupported = 201,
        ServerErr = 1000
    };

    declare var ServerError = function(message: string, type: ServerErrorType, ste1?: number, ste2?: number, fpLibError?: number): void { } as new(message: string, type: ServerErrorType, ste1?: number, ste2?: number, fpLibError?: number) => ServerError;
    declare interface ServerError {
        message: string;
        type: ServerErrorType;
        ste1?: number;
        ste2?: number;
        fpLibError?: number;
        isFpException: boolean;
    }
}

interface Date {
    toTremolFpString(): string;
    toStringWithFormat(format): string;
}

interface DateConstructor {
    TremolFpFormat: string;
}

interface Number {
    lpad(size: number): string;
}

interface String {
    replaceAll(search: string, replacement: string): string;
    parseDateWithFormat(format: string): Date;
    base64stringToArrayBuffer() : Uint8Array;
    escapeForXML(): string;
}

interface Uint8Array {
    toBase64string(): string;
    toUnicodeString(): string;
}