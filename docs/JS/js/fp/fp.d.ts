declare namespace Tremol {
	declare interface FP {
		timeStamp: number;
		/**
		 * Change SD card.
		 */
		ChangeSDcard(Password: string, SerialNum: string, PINnum: string): void;
		/**
		 * Start a device update procedure if a new update is available.
		 */
		StartDeviceUpdate(): void;
		/**
		 * Start WiFi test on the device the result
		 */
		StartWiFiTest(): void;
		/**
		 * Provides information about the manufacturing number of the CU and PIN number.
		 */
		ReadCUnumbers(): CUnumbersRes;
		/**
		 * Program service contract password
		 */
		ProgramServiceContractPassword(Old_Password: string, New_Password: string): void;
		/**
		 * Store Electronic Journal Report from report from date to date to External USB, External SD card.
		 */
		StoreEJByDate(OptionReportStorage: Tremol.Enums.OptionReportStorage, StartRepFromDate: Date, EndRepFromDate: Date): void;
		/**
		 * Shows a 16-symbols text in the first line and last 16-symbols text in the second line of the external display lines.
		 */
		DisplayTextLines1and2(Text: string): void;
		/**
		 * Provides information about the current date and time.
		 */
		ReadDateTime(): Date;
		/**
		 * Available only if the receipt is not closed. Cancel all sales in the receipt and close it .
		 */
		CancelReceipt(): void;
		/**
		 * Provides information about device's idle timeout. This timeout is seconds in which the connection will be closed when there is an inactivity. This information is available if the device has LAN or WiFi. Maximal value - 7200, minimal value 1. 0 is for never close the connection.
		 */
		Read_IdleTimeout(): number;
		/**
		 * Read invoice threshold count
		 */
		ReadInvoice_Threshold(): number;
		/**
		 * Read time threshold minutes
		 */
		ReadTimeThreshold_Minutes(): number;
		/**
		 * Providing information about server HTTPS address.
		 */
		ReadHTTPS_Server(): HTTPS_ServerRes;
		/**
		 * Program device's MAC address . To apply use - SaveNetworkSettings()
		 */
		SetDeviceTCP_MACAddress(MACAddress: string): void;
		/**
		 * Register the sell (for correction use minus sign in the price field) of article with specified name, price, quantity, VAT class and/or discount/addition on the transaction.
		 */
		SellPLUfromExtDB_HS(NamePLU: string, Price: number, HSCode: string, Quantity?: number, DiscAddP?: number): void;
		/**
		 * Provides information about device's GRPS APN.
		 */
		ReadGPRS_APN(): GPRS_APNRes;
		/**
		 * Providing information about device's GPRS user name.
		 */
		ReadGPRS_Username(): GPRS_UsernameRes;
		/**
		 * After every change on Idle timeout, LAN/WiFi/GPRS usage, LAN/WiFi/TCP/GPRS password or TCP auto start networks settings this Save command needs to be execute.
		 */
		SaveNetworkSettings(): void;
		/**
		 * Provides information about the accumulated EOD turnover and VAT amounts by date
		 */
		ReadEODAmountsByDate(EOD_Date: Date): EODAmountsByDateRes;
		/**
		 * Provides information about device's network IP address, subnet mask, gateway address, DNS address.
		 */
		ReadDeviceTCP_Addresses(OptionAddressType: Tremol.Enums.OptionAddressType): DeviceTCP_AddressesRes;
		/**
		 * Executes the direct command .
		 */
		DirectCommand(Input: string): string;
		/**
		 * Read Electronic Journal Report by initial to end date and time.
		 */
		ReadEJByDateTime(OptionReportFormat: Tremol.Enums.OptionReportFormat, StartRepFromDate: Date, EndRepFromDate: Date): void;
		/**
		 * Provides information about timeout when reading from a server. This time is in the seconds. Minimum value: 120, maximum value: 6000.
		 */
		Read_ServerReadingTimeout(): number;
		/**
		 * Opens receipt after which makes sell of article with specified name, price, quantity, VAT class and/or discount/addition on the transaction and then closes the receipt
		 */
		OpenSellAndCloseReceipt(TraderSystemInvNum: string, NamePLU: string, OptionVATClass: Tremol.Enums.OptionVATClass, Price: number, MeasureUnit: string, HSCode: string, Quantity?: number, DiscAddP?: number): OpenSellAndCloseReceiptRes;
		/**
		 * Program device's TCP WiFi network name where it will be connected. To apply use -SaveNetworkSettings()
		 */
		SetWiFi_NetworkName(WiFiNameLength: number, WiFiNetworkName: string): void;
		/**
		 * Programs HS code at a given position (HS number in order).
		 */
		ReadHScode(HS_Number: number): HScodeRes;
		/**
		 * Provides information about documents sending functions .
		 */
		ReadDiagnostics(): DiagnosticsRes;
		/**
		 * Read whole Electronic Journal report from beginning to the end in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJ_JSON(): number;
		/**
		 * Read Electronic Journal Report by CU Invoice Number (Multiple invoices)
		 */
		ReadEJByCUInvoiceNum(OptionInvoiceReportFormat: Tremol.Enums.OptionInvoiceReportFormat, StartCUInvoiceNum: number, EndCUInvoiceNum: number): void;
		/**
		 * Shows a 20-symbols text in the upper external display line.
		 */
		DisplayTextLine1(Text: string): void;
		/**
		 * Provides information about the current VAT rates (the last value stored in FM).
		 */
		ReadVATrates(): VATratesRes;
		/**
		 * Opens a fiscal invoice debit note receipt assigned to the specified operator number and operator password with free info for customer data. The Invoice receipt can be issued only if the invoice range (start and end numbers) is set.
		 */
		OpenDebitNoteWithFreeCustomerData(CompanyName: string, ClientPINnum: string, HeadQuarters: string, Address: string, PostalCodeAndCity: string, ExemptionNum: string, RelatedInvoiceNum: string, TraderSystemInvNum: string): void;
		/**
		 * Read Electronic Journal Report by initial to end date and time in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJByDateTime_JSON(OptionReportFormat: Tremol.Enums.OptionReportFormat, StartRepFromDate: Date, EndRepFromDate: Date): number;
		/**
		 * Provides information about the proxy server address.
		 */
		ReadProxyServerAddress(): ProxyServerAddressRes;
		/**
		 * Read the number of HS codes.
		 */
		ReadHScodeNumber(): number;
		/**
		 * Provides information about the number of the last issued receipt.
		 */
		ReadLastAndTotalReceiptNum(): LastAndTotalReceiptNumRes;
		/**
		 * Clears the external display.
		 */
		ClearDisplay(): void;
		/**
		 * Program device's TCP network DHCP enabled or disabled. To apply use -SaveNetworkSettings()
		 */
		SetDHCP_Enabled(OptionDHCPEnabled: Tremol.Enums.OptionDHCPEnabled): void;
		/**
		 * Program device's GPRS APN. To apply use -SaveNetworkSettings()
		 */
		SetGPRS_APN(gprsAPNlength: number, APN: string): void;
		/**
		 * Read GPRS APN authentication type
		 */
		ReadGPRS_AuthenticationType(): Tremol.Enums.OptionAuthenticationType;
		/**
		 * Read Electronic Journal Report by PIN number of buyer.
		 */
		ReadEJByPINofBuyer(OptionPINReportFormat: Tremol.Enums.OptionPINReportFormat, PINnumber: string): void;
		/**
		 * Programs the customer DB for special customer receipt issuing.
		 */
		AddNewHScode(HS_Code: string, HS_Name: string, OptionTaxable: Tremol.Enums.OptionTaxable, MesureUnit: string, VAT_rate: number): void;
		/**
		 * Stores the Manufacturing number into the operative memory.
		 */
		SetSerialNum(Password: string, SerialNum: string): void;
		/**
		 *  Reads raw bytes from FP.
		 */
		RawRead(Count: number, EndChar: string): Uint8Array;
		/**
		 * Provides information about device's DHCP status
		 */
		ReadDHCP_Status(): Tremol.Enums.OptionDHCPEnabled;
		/**
		 * Shows the current date and time on the external display.
		 */
		DisplayDateTime(): void;
		/**
		 * Program device's autostart TCP conection in sale/line mode. To apply use -SaveNetworkSettings()
		 */
		SetTCP_AutoStart(OptionTCPAutoStart: Tremol.Enums.OptionTCPAutoStart): void;
		/**
		 * Selects the active communication module - LAN or WiFi. This option can be set only if the device has both modules at the same time. To apply use - SaveNetworkSettings()
		 */
		SetTCP_ActiveModule(OptionUsedModule: Tremol.Enums.OptionUsedModule): void;
		/**
		 * Provides information about which module the device is in use: LAN or WiFi module. This information can be provided if the device has mounted both modules.
		 */
		ReadTCP_UsedModule(): Tremol.Enums.OptionUsedModule;
		/**
		 * Provides information about device's MAC address.
		 */
		ReadTCP_MACAddress(): string;
		/**
		 * Read the service contract expiry date
		 */
		ReadServiceContractExpiryDate(): ServiceContractExpiryDateRes;
		/**
		 * Closes the opened fiscal receipt and returns receipt info.
		 */
		CloseReceipt(): CloseReceiptRes;
		/**
		 * Opens a fiscal invoice credit note receipt assigned to the specified operator number and operator password with free info for customer data. The Invoice receipt can be issued only if the invoice range (start and end numbers) is set.
		 */
		OpenCreditNoteWithFreeCustomerData(CompanyName: string, ClientPINnum: string, HeadQuarters: string, Address: string, PostalCodeAndCity: string, ExemptionNum: string, RelatedInvoiceNum: string, TraderSystemInvNum: string): void;
		/**
		 * Provides information about device's TCP port number.
		 */
		ReadTcpPortNumber(): number;
		/**
		 * Shows a 16-symbols text in the lower external display line.
		 */
		DisplayTextLine2(Text: string): void;
		/**
		 * Read Electronic Journal Report by Trader System Invoice Number (Single Invoice).
		 */
		ReadEJByTraderSystemInvNum(OptionTraderSystemReportFormat: Tremol.Enums.OptionTraderSystemReportFormat, TraderSystemInvNum: string): void;
		/**
		 * Program device's TCP WiFi password where it will be connected. To apply use -SaveNetworkSettings()
		 */
		SetWiFi_Password(PassLength: number, Password: string): void;
		/**
		 * Provide information from the last communication with the server.
		 */
		ReadInfoFromLastServerCommunication(OptionServerResponse: Tremol.Enums.OptionServerResponse, OptionTransactionType: Tremol.Enums.OptionTransactionType): InfoFromLastServerCommunicationRes;
		/**
		 * Request for original invoice number in case of open receipt rejection due to duplicate TRADER SYSTEM INVOICE NUMBER and response received.
		 */
		ReadCUinvoiceNumber(): string;
		/**
		 * Confirm PIN number.
		 */
		ConfirmFiscalization(Password: string): void;
		/**
		 * Store whole Electronic Journal report to External SD card.
		 */
		StoreEJ(OptionReportStorage: Tremol.Enums.OptionReportStorage): void;
		/**
		 * Provides information about first EOD date
		 */
		ReadFirstEODDate(): Date;
		/**
		 * Program expiration date of the service contract
		 */
		ProgramExpirationServiceContract(Password: string, OptionActivation: Tremol.Enums.OptionActivation, ExpiryDate: Date): void;
		/**
		 * FlagsModule is a char with bits representing modules supported by the firmware
		 */
		ReadDeviceModuleSupportByFirmware(): DeviceModuleSupportByFirmwareRes;
		/**
		 * Providing information about WiFi password where the device is connected.
		 */
		ReadWiFi_Password(): WiFi_PasswordRes;
		/**
		 * Read Electronic Journal Report by PIN number of buyer in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJByPINofBuyer_JSON(OptionPINReportFormat: Tremol.Enums.OptionPINReportFormat, PINnumber: string): number;
		/**
		 * Provides information about device's NTP address.
		 */
		ReadNTP_Address(): NTP_AddressRes;
		/**
		 * Provides information about the accumulated amounts and refunded amounts by VAT class in case that CU regularly informs about the Z report(7C)
		 */
		ReadDailyAmountsByVAT(): DailyAmountsByVATRes;
		/**
		 * Reads all messages from log
		 */
		ReadTotalMessagesCount(): string;
		/**
		 * Programs invoice threshold count
		 */
		SetInvoice_ThresholdCount(Value: number): void;
		/**
		 * Program device used to talk with the server . To apply use - SaveNetworkSettings()
		 */
		SetServer_UsedComModule(OptionModule: Tremol.Enums.OptionModule): void;
		/**
		 * Program device's TCP password. To apply use - SaveNetworkSettings()
		 */
		SetTCP_Password(PassLength: number, Password: string): void;
		/**
		 * Programs GPRS APN authentication type
		 */
		SetGPRS_AuthenticationType(OptionAuthenticationType: Tremol.Enums.OptionAuthenticationType): void;
		/**
		 * Read the current status of the receipt.
		 */
		ReadCurrentReceiptInfo(): CurrentReceiptInfoRes;
		/**
		 * Read whole Electronic Journal report from beginning to the end.
		 */
		ReadEJ(): void;
		/**
		 * The device scan out the list of available WiFi networks.
		 */
		ScanWiFiNetworks(): void;
		/**
		 * Program device's network IP address, subnet mask, gateway address, DNS address. To apply use -SaveNetworkSettings()
		 */
		SetDeviceTCP_Addresses(OptionAddressType: Tremol.Enums.OptionAddressType, DeviceAddress: string): void;
		/**
		 * Read Electronic Journal Report by initial to end date in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJByDate_JSON(StartRepFromDate: Date, EndRepFromDate: Date): number;
		/**
		 * Read Electronic Journal Report by Trader System Invoice Number (Single Invoice) in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJByTraderSystemInvNum_JSON(OptionTraderSystemReportFormat: Tremol.Enums.OptionTraderSystemReportFormat, TraderSystemInvNum: string): number;
		/**
		 * Provides detailed 6-byte information about the current status of the CU.
		 */
		ReadStatus(): StatusRes;
		/**
		 * Opens a fiscal receipt assigned to the specified operator number and operator password, parameters for receipt format and VAT type.
		 */
		OpenReceipt(OptionReceiptFormat: Tremol.Enums.OptionReceiptFormat, TraderSystemInvNum: string): void;
		/**
		 * Sets the date and time and current values.
		 */
		SetDateTime(DateTime: Date): void;
		/**
		 * Register the sell (for correction use minus sign in the price field) of article with specified name, price, quantity, VAT class and/or discount/addition on the transaction.
		 */
		SellPLUfromExtDB(NamePLU: string, OptionVATClass: Tremol.Enums.OptionVATClass, Price: number, MeasureUnit: string, HSCode: string, HSName: string, VATGrRate: number, Quantity?: number, DiscAddP?: number): void;
		/**
		 * Start GPRS test on the device the result
		 */
		StartGPRStest(): void;
		/**
		 * Opens invoice after which makes sell of article with specified name, price, quantity, VAT class and/or discount/addition on the transaction and then closes the invoice
		 */
		OpenSellAndCloseInvoice(ClientPINnum: string, ExemptionNum: string, TraderSystemInvNum: string, NamePLU: string, OptionVATClass: Tremol.Enums.OptionVATClass, Price: number, MeasureUnit: string, HSCode: string, Quantity?: number, DiscAddP?: number): OpenSellAndCloseInvoiceRes;
		/**
		 * Opens a fiscal invoice receipt assigned to the specified operator number and operator password with free info for customer data. The Invoice receipt can be issued only if the invoice range (start and end numbers) is set.
		 */
		OpenInvoiceWithFreeCustomerData(CompanyName: string, ClientPINnum: string, HeadQuarters: string, Address: string, PostalCodeAndCity: string, ExemptionNum: string, TraderSystemInvNum: string): void;
		/**
		 * Program device's GPRS password. To apply use - SaveNetworkSettings()
		 */
		SetGPRS_Password(PassLength: number, Password: string): void;
		/**
		 * Restore default parameters of the device.
		 */
		SoftwareReset(Password: string): void;
		/**
		 * Provides information for the daily fiscal report  with zeroing and fiscal memory record, preceded by Electronic Journal report.
		 */
		DailyReport(): void;
		/**
		 * Provides information about device's TCP password.
		 */
		ReadTCP_Password(): TCP_PasswordRes;
		/**
		 * Stores a block containing the values of the VAT rates into the CU
		 */
		ProgVATrates(Password: string, VATrateA: number, VATrateB: number, VATrateC: number, VATrateD: number, VATrateE: number): void;
		/**
		 * Program device's NTP address . To apply use - SaveNetworkSettings()
		 */
		SetDeviceNTP_Address(AddressLen: number, NTPAddress: string): void;
		/**
		 * Read Electronic Journal Report by initial to end date.
		 */
		ReadEJByDate(StartRepFromDate: Date, EndRepFromDate: Date): void;
		/**
		 * Store Electronic Journal Report by PIN number of buyer to External SD card.
		 */
		StoreEJByPINofBuyer(OptionReportStorage: Tremol.Enums.OptionReportStorage, OptionPINReportFormat: Tremol.Enums.OptionPINReportFormat, PINnumber: string): void;
		/**
		 * Store Electronic Journal Report from report from datetime to datetime to External SD card.
		 */
		StoreEJByDateTime(OptionReportStorage: Tremol.Enums.OptionReportStorage, OptionReportFormat: Tremol.Enums.OptionReportFormat, StartRepFromDate: Date, EndRepFromDate: Date): void;
		/**
		 * Informs about the issued document
		 */
		InfoLastReceiptDuplicate(): void;
		/**
		 * Store Electronic Journal Report by Trader System Invoice Number (Single Invoice) to External SD card.
		 */
		StoreEJByTraderSystemInvNum(OptionReportStorage: Tremol.Enums.OptionReportStorage, OptionTraderSystemReportFormat: Tremol.Enums.OptionTraderSystemReportFormat, TraderSystemInvNum: string): void;
		/**
		 * Program device's idle timeout setting. Set timeout for closing the connection if there is an inactivity. Maximal value - 7200, minimal value 1. 0 is for never close the connection. This option can be used only if the device has LAN or WiFi. To apply use - SaveNetworkSettings()
		 */
		SetIdle_Timeout(IdleTimeout: number): void;
		/**
		 * Provides information about if the TCP connection autostart when the device enter in Line/Sale mode.
		 */
		ReadTCP_AutoStartStatus(): Tremol.Enums.OptionTCPAutoStart;
		/**
		 * Provides information about device's GPRS password.
		 */
		ReadGPRS_Password(): GPRS_PasswordRes;
		/**
		 * Read device communication usage with server
		 */
		ReadServer_UsedComModule(): Tremol.Enums.OptionModule;
		/**
		 * Program the service contract expired warning message text.
		 */
		ProgContractWarningMessages(Password: string, Line1: string, Line2: string, Line3: string): void;
		/**
		 * Reads specific message number
		 */
		ReadSpecificMessage(MessageNum: string): SpecificMessageRes;
		/**
		 * Program TCP port of the device.
		 */
		SetTcpPortNumber(TcpPortNumber: number): void;
		/**
		 * Programs server HTTPS address.
		 */
		SetHTTPS_Address(ParamLength: number, Address: string): void;
		/**
		 * Calculate the subtotal amount with printing and display visualization options. Provide information about values of the calculated amounts. If a percent or value discount/addition has been specified the subtotal and the discount/addition value will be printed regardless the parameter for printing.
		 */
		Subtotal(OptionDisplay: Tremol.Enums.OptionDisplay, DiscAddV?: number, DiscAddP?: number): number;
		/**
		 * Erase HS codes.
		 */
		EraseHScodes(Password: string): void;
		/**
		 * Stores PIN number in operative memory.
		 */
		SetPINnumber(Password: string, PINnum: string): void;
		/**
		 * Program the proxy server address.
		 */
		ProgramProxyServerAddress(ParamLength: number, Address: string): void;
		/**
		 * Read Electronic Journal Report by CU Invoice Number (Multiple invoices) in the JSON format. The number of bytes equal to Length for JSON data must be read subsequently.
		 */
		ReadEJByCUInvoiceNum_JSON(OptionInvoiceReportFormat: Tremol.Enums.OptionInvoiceReportFormat, StartCUInvoiceNum: number, EndCUInvoiceNum: number): number;
		/**
		 * Programming timeout when reading from server. This timeout is seconds. Minimum value: 120, maximum value: 6000.
		 */
		ProgramServerReadingTimeout(ReadingTimeout: number): void;
		/**
		 * Read/Store Invoice receipt copy to External SD card.
		 */
		ReadOrStoreInvoiceCopy(OptionInvoiceCopy: Tremol.Enums.OptionInvoiceCopy, CUInvoiceNum: string): void;
		/**
		 * Provides information about the accumulated EOD turnover and VAT
		 */
		ReadEODAmounts(): EODAmountsRes;
		/**
		 * Start LAN test on the device the result
		 */
		StartLANtest(): void;
		/**
		 * FlagsModule is a char with bits representing modules supported by the device.
		 */
		ReadDeviceModuleSupport(): DeviceModuleSupportRes;
		/**
		 * Store Electronic Journal Report by CU Invoice Number (Multiple invoices) to External SD card.
		 */
		StoreEJByCUInvoiceNum(OptionReportStorage: Tremol.Enums.OptionReportStorage, OptionInvoiceReportFormat: Tremol.Enums.OptionInvoiceReportFormat, StartCUInvoiceNum: number, EndCUInvoiceNum: number): void;
		/**
		 * Provides information about WiFi network name where the device is connected.
		 */
		ReadWiFi_NetworkName(): WiFi_NetworkNameRes;
		/**
		 * Provides information about the device version.
		 */
		ReadVersion(): string;
		/**
		 * Read the service contract warning message text.
		 */
		ReadContractWarningMessage(): ContractWarningMessageRes;
		/**
		 *  Writes raw bytes to FP 
		 */
		RawWrite(Bytes: Uint8Array): void;
		/**
		 * Programs HS code at a given position (HS number in order).
		 */
		ProgHScode(HS_Number: number, HS_Code: string, HS_Name: string, OptionTaxable: Tremol.Enums.OptionTaxable, MesureUnit: string, VAT_Rate: number): void;
		/**
		 * Programs time threshold minutes
		 */
		SetTime_ThresholdMinutes(Value: number): void;
	}

	declare namespace Enums {
		declare enum OptionReportStorage {
			Storage_in_External_SD_card_memory = 'J4',
			Storage_in_External_SD_card_memory_for_JSON = 'JX',
		}
		declare enum OptionAddressType {
			DNS_address = '5',
			Gateway_address = '4',
			IP_address = '2',
			Subnet_Mask = '3',
		}
		declare enum OptionReportFormat {
			Brief_EJ = 't',
			Detailed_EJ = 'T',
		}
		declare enum OptionVATClass {
			VAT_Class_A = 'A',
		}
		declare enum OptionTaxable {
			Exempted = '1',
			Taxable = '0',
		}
		declare enum OptionDeviceType {
			A_Type = '1',
			B_Type = '2',
		}
		declare enum OptionInvoiceReportFormat {
			Brief_EJ = 'n',
			Detailed_EJ = 'N',
		}
		declare enum OptionDHCPEnabled {
			Disabled = '0',
			Enabled = '1',
		}
		declare enum OptionAuthenticationType {
			CHAP = '2',
			None = '0',
			PAP = '1',
			PAP_or_CHAP = '3',
		}
		declare enum OptionPINReportFormat {
			Brief_EJ = 'p',
			Detailed_EJ = 'P',
		}
		declare enum OptionTCPAutoStart {
			No = '0',
			Yes = '1',
		}
		declare enum OptionUsedModule {
			LAN_module = '1',
			WiFi_module = '2',
		}
		declare enum OptionActivation {
			No = '0',
			Yes = '1',
		}
		declare enum OptionTraderSystemReportFormat {
			Brief_EJ = 's',
			Detailed_EJ = 'S',
		}
		declare enum OptionServerResponse {
			At_send_EOD = 'Z',
			At_send_receipt = 'R',
		}
		declare enum OptionTransactionType {
			Error_Code = 'c',
			Error_Message = 'm',
			Exception_Message = 'e',
			Response_Code = 'r',
			Status = 's',
		}
		declare enum OptionLAN {
			No = '0',
			Yes = '1',
		}
		declare enum OptionWiFi {
			No = '0',
			Yes = '1',
		}
		declare enum OptionGPRS {
			No = '0',
			Yes = '1',
		}
		declare enum OptionBT {
			No = '0',
			Yes = '1',
		}
		declare enum OptionModule {
			GSM = '0',
			LANWiFi = '1',
		}
		declare enum OptionIsReceiptOpened {
			No = '0',
			Yes = '1',
		}
		declare enum OptionReceiptFormat {
			Brief = '0',
			Detailed = '1',
		}
		declare enum OptionClientReceipt {
			invoice_client_receipt = '1',
			standard_receipt = '0',
		}
		declare enum OptionPowerDownInReceipt {
			No = '0',
			Yes = '1',
		}
		declare enum OptionDisplay {
			No = '0',
			Yes = '1',
		}
		declare enum OptionInvoiceCopy {
			Reading = 'J0',
			Storage_in_External_SD_card_memory = 'J4',
		}
	}
}