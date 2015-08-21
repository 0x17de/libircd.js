var libircd = require("./libircd.js");

var server = new libircd.IrcServer();
server.start('0.0.0.0', 6667);

