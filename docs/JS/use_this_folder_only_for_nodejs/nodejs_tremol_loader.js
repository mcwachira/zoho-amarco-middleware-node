module.exports.load = function(paths) {
    var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
    var DOMParser = require('xmldom').DOMParser;
    for(var i = 0; i < paths.length; i++) {
        eval(require('fs').readFileSync(paths[i], 'utf8'));
    }
    return Tremol;
}