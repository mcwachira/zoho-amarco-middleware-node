/**
 * Module nodejs_tremol_loader loads Tremol javascript libraries.
 * It requires modules 'xmlhttprequest' and 'xmldom', which can be installed by:
 * 'npm i xmlhttprequest', 'npm i xmldom'
 * The module returns @namespace {Tremol}, which contains;
 * functions 'FP', 'ServerError', enumerations 'Enums', 'ServerErrorType'
 */
var Tremol = require("./nodejs_tremol_loader").load(["./fp_core.js", "./fp.js"]);
/** 
 * Object fp contains all fiscal device commands
 */
var fp = new Tremol.FP();
try {
    fp.ServerSetSettings("http://localhost:4444/");
    //fp.ServerSetDeviceTcpSettings("1.2.3.4", 8000, "password"); //If FD is connected on LAN/WIFI
    var res = fp.ServerFindDevice(); //Finds FD connected on serial port
    if(res) {
        fp.ServerSetDeviceSerialSettings(res.serialPort, res.baudRate, false); //If FD is connected on serial port or USB
        fp.PrintDiagnostics(); // Prints diagnostic receipt
    }
    else {
        console.log("Device not found");
    }
    
}
catch(ex) {
    if(ex instanceof Tremol.ServerError) {
        console.log('Tremol server error!');
        console.log(ex); //TODO for proper error handling please check file demo.js, function handleException
    } else {
        console.log(ex);
    }
}