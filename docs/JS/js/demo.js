//@ts-check

var fp = new Tremol.FP();

function handleException(sx) {
    if(sx instanceof Tremol.ServerError)
    {
        if(sx.isFpException)
        {
            /**
            Possible reasons:  
            sx.STE1 =                                              sx.STE2 =
                0x30 OK                                                   0x30 OK                                 
                0x31 Out of paper, printer failure                        0x31 Invalid command
                0x32 Registers overflow                                   0x32 Illegal command
                0x33 Clock failure or incorrect date&time                 0x33 Z daily report is not zero
                0x34 Opened fiscal receipt                                0x34 Syntax error
                0x35 Payment residue account                              0x35 Input registers overflow
                0x36 Opened non-fiscal receipt                            0x36 Zero input registers
                0x37 Registered payment but receipt is not closed         0x37 Unavailable transaction for correction
                0x38 Fiscal memory failure                                0x38 Insufficient amount on hand
                0x39 Incorrect password                                   0x3A No access
                0x3a Missing external display
                0x3b 24hours block – missing Z report
                0x3c Overheated printer thermal head.
                0x3d Interrupt power supply in fiscal receipt (one time until status is read)
                0x3e Overflow EJ
                0x3f Insufficient conditions
            **/
            if (sx.ste1 === 0x30 && sx.ste2 === 0x32)
            {
                alert("sx.STE1 === 0x30 - command is OK  AND  sx.STE2 === 0x32 - command is illegal in current context");
            }
            else if (sx.ste1 === 0x30 && sx.ste2 === 0x33)
            {
                alert("sx.STE1 === 0x30 - command is OK  AND sx.STE2 === 0x33 - make Z report");
            }
            else if (sx.ste1 === 0x34 && sx.ste2 === 0x32)
            {
                alert("sx.STE1 === 0x34 - Opened fiscal receipt  AND  sx.STE2 === 0x32 - command is illegal in current context");
            }
            else if (sx.ste1 === 0x39 && sx.ste2 === 0x32) {
                alert("sx.STE1 === 0x39 - Wrong password AND sx.STE2 == 0x32 - command is illegal in current context");
            }
            else
            {
                alert(sx.message + "\nSTE1=" + sx.ste1 + ", STE2=" + sx.ste2);                
            }
        }
        else if(sx.type === Tremol.ServerErrorType.ServerDefsMismatch)
        {
            alert("The current library version and server definitions version do not match");
        }
        else if (sx.type === Tremol.ServerErrorType.ServMismatchBetweenDefinitionAndFPResult)
        {
            alert("The current library version and the fiscal device firmware is not matching");
        }
        else if (sx.type ===  Tremol.ServerErrorType.ServerAddressNotSet)
        {
            alert("Specify server ServerAddress property ");
        }
        else if (sx.type ===  Tremol.ServerErrorType.ServerConnectionError)
        {
            alert("Connection from this app to the server is not established");
        }
        else if (sx.type ===  Tremol.ServerErrorType.ServSockConnectionFailed)
        {
            alert("When the server can not connect to the fiscal device");
        }
        else if (sx.type ===  Tremol.ServerErrorType.ServTCPAuth)
        {
            alert("Wrong device ТCP password");
        }
        else if (sx.type ===  Tremol.ServerErrorType.ServWaitOtherClientCmdProcessingTimeOut)
        {
            alert("Proccessing of other clients command is taking too long");
        }
        else
        {
            alert(sx.message);
        }
    }
    else
    {
        alert(sx.message);
    }
};


function fpGetLibraryVersions()
{
    try
    {
        alert("Core version: " + fp.GetVersionCore() + "\r\nLibrary definitions: " + String(fp.GetVersionDefinitions()));
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpServerSetSettings()
{
    try
    {
        var ip = getInputValue("server_ip");
        var port = Number(getInputValue("server_port"));
        fp.ServerSetSettings(ip, port);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

/**
 * @param {Tremol.FP.DeviceSettings} fps 
 */
function fpServerSetDeviceSettings(fps)
{
    try
    {
        if(fps.isWorkingOnTcp)
        {
            fp.ServerSetDeviceTcpSettings(fps.ipaddress, fps.tcpPort, fps.password);
        }
        else
        {
            fp.ServerSetDeviceSerialSettings(fps.serialPort, fps.baudRate, fps.keepPortOpen);
        }
        if(!fp.IsCompatible())
        {
            throw new Error("Server and client versions are different!");
        }
    }
    catch(ex)
    {
        handleException(ex);
    }
};

/**
 * @returns {Tremol.FP.DeviceSettings}
 */
function fpServerFindDevice()
{
    try
    {
        var dev = fp.ServerFindDevice();
        if(!dev) {
            alert("Device not found!");
        }
        else {
            alert("Device found on " + dev.serialPort + " with baud " + dev.baudRate);
        }
        return dev;
    }
    catch(ex)
    {
        handleException(ex);
    }
}

function fpDiagnostics()
{
    try
    {
        fp.PrintDiagnostics();
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpGSReadDeviceInfo()
{
    try
    {
        fp.RawWrite(new Uint8Array([0x1D, 0x49]));
        var res = fp.RawRead(0, "\n");
        var resutf = res.toUnicodeString().trim();
        alert(resutf);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpReadVersion()
{
    try
    {
        var v = fp.ReadVersion();
        alert("Version: " + v);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpXReport()
{
    try
    {
        fp.PrintDailyReport(Tremol.Enums.OptionZeroing.Without_zeroing);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpZReport()
{
    try
    {
        fp.PrintDailyReport(Tremol.Enums.OptionZeroing.Zeroing);
    }
    catch(ex)
    {
        handleException(ex);
    }
};


function fpOpenFiscReceipt()
{
    try
    {
        var op1pass = getInputValue("fp_op1_pass");
        /** To execute this command please check all parameters */
        fp.OpenReceipt(1, op1pass, Tremol.Enums.OptionReceiptFormat.Brief, Tremol.Enums.OptionFiscalReceiptPrintType.Step_by_step_printing);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpSalePLU()
{
    try
    {
        var name = getInputValue("fp_art_name");
        var qty = Number(getInputValue("fp_art_qty"));
        var price = Number(getInputValue("fp_art_price"));
        var hsCode = getInputValue("fp_art_hs_code");
        /** To execute this command please check all parameters */
        fp.SellPLUfromExtDB_HS(name, price, hsCode, qty);
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpCloseReceiptInCash()
{
    try
    {
       fp.CashPayCloseReceipt();
    }
    catch(ex)
    {
        handleException(ex);
    }
};

function fpCancelFiscalReceipt()
{
    try
    {
       fp.CancelReceipt();
    }
    catch(ex)
    {
        handleException(ex);
    }
};
