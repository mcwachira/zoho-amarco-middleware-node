var devices = [];
var currentDeviceIdx = -1;

document.onreadystatechange = function ()
{
    if(!( /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)))
    {
        document.body.style.transform  = "scale(1.4)";
        document.body.style.transformOrigin = "50% 0%";
    }
};

function getInputValue(id) {
    var el = document.getElementById(id);
    if(el instanceof HTMLInputElement) {
        return el.value;
    }
    else {
        throw new Error('Invalid HTMLInputElement id:' + id);
    }
};

function refreshServerButton()
{
    var ip = getInputValue("server_ip");
    var port = Number(getInputValue("server_port"));
    document.getElementById("but_show_lab_settings").innerHTML = "ZfpLab Server = " + ip + ":" + port;
};

function findDevice()
{
    try
    {
        var devsettings = fpServerFindDevice();
        if(devsettings)
        {
            document.getElementById("dev_com").value = devsettings.serialPort;
            document.getElementById("dev_baud").value = devsettings.baudRate.toString();
        }
    }
    catch(ignored) { }
}

function addDevice(tcp)
{
    try
    {
        /** @type {Tremol.FP.DeviceSettings} */
        var dev = { };
        var name = "";
        if(tcp)
        {
            name = getInputValue("dev_name");
            dev.isWorkingOnTcp = true;
        }
        else
        {
            name = getInputValue("dev_name2");
            dev.isWorkingOnTcp = false;
        }
        dev.ipaddress = getInputValue("dev_ip");
        dev.tcpPort = Number(getInputValue("dev_port"));
        dev.password = getInputValue("dev_pass");
        dev.serialPort = getInputValue("dev_com");
        dev.baudRate = Number(getInputValue("dev_baud"));
        dev.keepPortOpen = document.getElementById("dev_keep_open").checked;
        var panel = document.getElementById("devices");
        var rbs = panel.getElementsByClassName("myradiobutton");
        var fnoncheck = function()
        {
            try
            {
                var idx = getSelectedDevIdx();
                if(idx > -1)
                {
                    var fps = devices[idx];
                    fpServerSetDeviceSettings(fps);
                }
            }
            catch(err)
            {
                alert(err);
            }
        };
        var rbs = document.getElementsByClassName("myradiobutton");
        var rb = addRadioButtonWithLabel(panel, name, rbs.length, false, fnoncheck);
        rb.style.marginLeft = "6px";
        devices.push(dev);
        selectLastDevice();

        showDevSettings(false);
        try
        {
            var idx = getSelectedDevIdx();
            var fps = devices[idx];
            fpServerSetDeviceSettings(fps);
        }
        catch(ignored)
        { }
    }
    catch(err)
    {
        alert(err);
    }
};

function addDeviceCancel()
{
    showDevSettings(false);
    if(getSelectedDevIdx() === -1)
    {
        showFunctions(false);
    }
};

function removeLastDevice()
{
    var panel = document.getElementById("devices");
    var rbs = panel.getElementsByClassName("myradiobutton");
    if(rbs.length > 0)
    {
        devices.splice(rbs.length - 1, 1);
        if(panel.lastChild)
        {
            panel.removeChild(panel.lastChild);
        }
        if(panel.lastChild)
        {
            panel.removeChild(panel.lastChild);
        }
        selectLastDevice();
    }
};

function getSelectedDevIdx()
{
    var rbs = document.getElementById("devices").getElementsByClassName("myradiobutton");
    for(var d = 0; d< rbs.length; d++)
    {
        if(rbs[d].checked)
        {
            currentDeviceIdx = d;
            return currentDeviceIdx;
        }
    }
    currentDeviceIdx = -1;
    return currentDeviceIdx;
};

function selectLastDevice()
{
    var idx = getSelectedDevIdx();
    if(idx === -1)
    {
        var rbs = document.getElementById("devices").getElementsByClassName("myradiobutton");
        if(rbs.length > 0)
        {
            rbs[rbs.length -1].checked = true;
            showFunctions(true);
        }
        else
        {
            showFunctions(false);
        }
        try
        {
            fp.ServerCloseDeviceConnection();
        }   
        catch(ignored) 
        { }
    }
};

function showServerSettings(visible)
{
    if(visible)
    {
        document.getElementById("server_settings").style.display = "block";
        document.getElementById("server_settings").style.visibility = "visible";
        document.getElementById("server_settings_hidden").style.visibility = "hidden";
        document.getElementById("server_settings_hidden").style.display = "none";
    }
    else
    {
        document.getElementById("server_settings").style.visibility = "hidden";
        document.getElementById("server_settings").style.display = "none";
        document.getElementById("server_settings_hidden").style.display = "block";
        document.getElementById("server_settings_hidden").style.visibility = "visible";
    }
};


function showFunctions(visible)
{
    if(visible)
    {
        document.getElementById("functions").style.display = "block";
        document.getElementById("functions").style.visibility = "visible";
    }
    else
    {
        document.getElementById("functions").style.display = "none";
        document.getElementById("functions").style.visibility = "hidden";
    }
};

function showDevSettings(visible)
{
    if(visible)
    {
        document.getElementById("device_settings").style.display = "block";
        document.getElementById("device_settings").style.visibility = "visible";
        document.getElementById("device_add_remove").style.display = "none";
        document.getElementById("device_add_remove").style.visibility = "hidden";
    }
    else
    {
        document.getElementById("device_settings").style.display = "none";
        document.getElementById("device_settings").style.visibility = "hidden";
        document.getElementById("device_add_remove").style.display = "block";
        document.getElementById("device_add_remove").style.visibility = "visible";
    }
    showFunctions(!visible);
};

function showTcpSettings(visible)
{
    if(visible)
    {
        document.getElementById("table_tcp").style.display = "block";
        document.getElementById("table_tcp").style.visibility = "visible";
        document.getElementById("table_com").style.visibility = "hidden";
        document.getElementById("table_com").style.display = "none";
    }
    else
    {
        document.getElementById("table_tcp").style.display = "none";
        document.getElementById("table_tcp").style.visibility = "hidden";
        document.getElementById("table_com").style.display = "block";
        document.getElementById("table_com").style.visibility = "visible";
    }
};

function addRadioButtonWithLabel (parent, lblText, idx, checked, extraFn) {
    var lbl = document.createElement("label");
    lbl.innerText = lblText;
    lbl.className = "mylabel";
    lbl.style.display = "inline";
    lbl.htmlFor = "myradiobutton" + idx;

    var input = document.createElement("input");
    input.type = "radio";
    input.className = "myradiobutton";
    input.id = "myradiobutton" + idx;
    if (checked) {
        input.checked = true;
    }
    var fnc = function() {
        var rs = this.parentElement.getElementsByClassName("myradiobutton");
        for(var i = 0; i< rs.length; i++)
        {
            if(rs[i] === input)
            {
                rs[i].checked = true;
            }
            else
            {
                rs[i].checked = false;
            }
        }
        if(extraFn !== null && input.checked)
        {
            extraFn();
        }
    };
    input.onclick = fnc;
    parent.appendChild(input);
    if(lblText !== null && lblText !== "")
    {
        parent.appendChild(lbl);
    }
    return input;
};