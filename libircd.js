exports.IrcServer = IrcServer;
exports.Channel = Channel;
exports.Client = Client;

var net = require('net');
var uuid = require('node-uuid');
var sha1 = require('sha1');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var version = '0.1.3';
var servHostname = 'example.com';

var STATE = {
	initial: 0,
	ready: 1
};
var KILLREASON = {
	timeout: 0,
	connectionClosed: 1,
	kill: 2,
	badPassword: 3,
	kick: 4
};
exports.KILLREASON = KILLREASON;

var handlerMap = {
	CAP: function(server, client, splitData, line) {
		switch (splitData[1]) {
		case 'LS':
			client.answer('CAP * LS :multi-prefix');
			break;
		case 'REQ':
			client.requests.push(splitData.slice(2));
			if (client.requests.length > 20)
				server.killClient(client, KILLREASON.kill);
			break;
		case 'END':
			if (client.state != STATE.ready)
				break;
			client.requests.forEach(function(req) {
				switch (req[0]) {
				case ':multi-prefix':
					client.answer('CAP '+client.nick+' ACK '+req[0]);
				}
			});
			break;
		default:
			console.log('Unknown cap: '+splitData[1]);
		}
	},
	PASS: function(server, client, splitData, line) {
		var password = line.substr(splitData[0].length+1);
		client.logged = server.passwordSha1 == sha1(password) && server.password == password;
	},
	NICK: function(server, client, splitData, line) {
		if (client.state != STATE.initial) return;
		if (server.password != null && !client.logged)
			server.killClient(client, KILLREASON.badPassword);

		if (server.checkSetNick(client, splitData[1]))
			client.state = STATE.ready;
	},
	USER: function(server, client, splitData, line) {
		client.user = splitData[1];
		client.sendWelcome();
	},
	JOIN: function(server, client, splitData, line) {
		if (client.state != STATE.ready) return;

		var channelString = splitData[1] || "";
		if (channelString.length == 0) return;
		var channelList = channelString.split(",");
		var keys = splitData[2];
		var keyList = (keys && keys.length > 0) ? keys.split(",") : [];
		channelList.forEach(function(channelName, i) {
			var key = keyList[i];
			var joinFunction = function() {
				server.clientJoinsChannel(client, channelName, key);
			}
			if (!server.emit('roomchange', {guid: client.guid, nick: client.nick, bJoin: true, channel: channelName, joinFunction: joinFunction}))
				joinFunction();
		});
	},
	PART: function(server, client, splitData, line) {
		if (client.state != STATE.ready) return;

		var channelString = splitData[1] || "";
		if (channelString.length == 0) return;
		var channelList = channelString.split(",");
		channelList.forEach(function(channelName) {
			server.clientLeavesChannel(client, channelName);
			server.emit('roomchange', {guid: client.guid, nick: client.nick, bJoin: false, channel: channelName});
		});
	},
	PING: function(server, client, splitData, line) {
		client.answer('PONG '+servHostname+' :'+splitData[1]);
	},
	PRIVMSG: function(server, client, splitData, line) {
		if (client.state != STATE.ready) return;

		var channelName = splitData[1];
		var message = line.substr(splitData[0].length+splitData[1].length+2);
		if (message[0] == ':') message = message.substr(1);

		var channel = client.channels[channelName];
		if (!channel) return;
		console.log(channel.name +' <'+client.nick+'> '+message);
		channel.deliverMessage(client, message);
		server.emit('message', {guid: client.guid, nick: client.nick, message: message, channel: channelName});
	}
};

function IrcServer(opt_password) {
	EventEmitter.call(this);
	this.password = opt_password;
	this.passwordSha1 = opt_password ? sha1(opt_password) : null;

	this.clientsByName = {};
	this.clientsByGuid = {};
	this.channels = {};
}
util.inherits(IrcServer, EventEmitter);
IrcServer.invalidChannelNameCharacters = [0x20, 0x07, 0x00, 0x0d, 0x0a, 0x2c];
IrcServer.prototype.isValidChannelName = function(name) {
	if (!name || name.length == 0) return false;
	if (name[0] != '#' && name[0] != '&') return false;
	for (var i = 0; i < name.length; ++i)
		if (IrcServer.invalidChannelNameCharacters.indexOf(name.charCodeAt(i)) >= 0) return false;
	return true;
}
IrcServer.nickNameValidator = new RegExp('^[a-z_]([a-z0-9\\[\\]\\\\`^{}_-])*$', 'i');
IrcServer.prototype.isNickInUse = function(name) {
	return !!this.clientsByName[name];
}
IrcServer.prototype.kick = function(nickOrClient, channelOrName) {
	var client = (nickOrClient instanceof Client) ? nickOrClient : this.clientsByName[nickOrClient];
	if (!client) return;
	this.clientLeavesChannel(client, channelOrName, KILLREASON.kick);
}
IrcServer.prototype.isValidNickName = function(name) {
	return IrcServer.nickNameValidator.test(name);
}
IrcServer.prototype.checkSetNick = function(client, nick) {
	if (nick.length > 0 && nick[0] == ':') nick = nick.substr(1);	
	if (!nick || nick.length == 0) {
		client.answer('431 '+nick+' :No nickname given');
		return false;
	}
	if (!this.isValidNickName(nick)) {
		client.answer('432 '+nick+' :Erroneus nickname');
		return false;
	}
	if (this.isNickInUse(nick)) {
		client.answer('433 '+nick+' :Nickname '+nick+' is already in use');
		return false;
	}
	client.setNickName(nick);

	this.addClient(client);
	this.emit('connect', {guid: client.guid, nick: nick});
	return true;
}
IrcServer.prototype.addClient = function(client) {
	this.clientsByName[client.nick] = client;
	var guid;
	do {
		guid = uuid.v4();
	} while(this.clientsByGuid[guid]);
	client.guid = guid;
	this.clientsByGuid[guid] = client;
}
IrcServer.prototype.getOrCreateChannel = function(channelName, opt_clientOperator) {
	var channel = this.channels[channelName];
	if (!channel) {
		this.channels[channelName] = channel = new Channel(channelName, opt_clientOperator);
		console.log("Channel created: "+channel.name);
	}
	return channel;
}
IrcServer.prototype.killClient = function(client, killReason) {
	switch (killReason) {
	case KILLREASON.badPassword:
		client.answer('ERROR :Access denied: Bad password?');
		break;
	}
	for (var i = 0; i < client.channels; ++i)
		this.clientLeavesChannel(client, client.channels[i], killReason);
	delete this.clientsByName[client.nick];
	delete this.clientsByGuid[client.guid];
	client.close();
	this.emit('kill', {guid: client.guid, nick: client.nick});
}
IrcServer.prototype.clientJoinsChannel = function(client, channelName, key) {
	// @TODO: use key
	if (!this.isValidChannelName(channelName)) {
		console.log('Invalid channel join: '+client.nick+' to '+channelName);
		client.answer('479 :'+channelName); // @TODO: add all nicks of channel
		return;
	}

	var channel = this.getOrCreateChannel(channelName, client);
	client.addChannel(channel);
	channel.addClient(client);
}
IrcServer.prototype.clientLeavesChannel = function(client, channelOrName, killReason) {
	var channel = (channelOrName instanceof Channel) ? channelOrName : this.channels[channelOrName];
	if (!channel) {
		console.log("PART Invalid channel: "+channelOrName);
		return;
	}
	channel.removeClient(client);
	client.removeChannel(channel);
	if (channel.clientCount == 0) {
		console.log("Remove channel: "+channel.name);
		delete this.channels[channelOrName];
	}
}
IrcServer.prototype.removeChannel = function(channelOrName) {
	var channel = (channelOrName instanceof Channel) ? channelOrName : this.channels[channelOrName];
	if (!channel) {
		console.log("CLOSE Invalid channel: "+channelOrName);
		return;
	}
	for (var i in channel.clients)
		this.kick(channel.clients[i], channel);
}
IrcServer.prototype.start = function(ip, port) {
	var self = this;
	this.timeCreated = (new Date()).toUTCString();
	net.createServer(function(c) {
		console.log('NEW client');
		var client = new Client(c);

		c.on('data', function(data) {
			data = String(data); // always string data
			lines = data.split('\n');
			while (lines.length > 0) {
				var line = lines.shift().replace('\r', '');
				if (line.length == 0) continue;
				var splitData = line.split(" ");
				if (splitData[0] == '') continue; // no / invalid command

				console.log('DATA: '+line);
	
				var handler = handlerMap[splitData[0]];
				if (handler)
					handler(self, client, splitData, line);
				else
					console.log("!! Unknown handler: "+splitData[0]);
			}
		});
		c.on('end', function() {
			self.killClient(client, KILLREASON.connectionClosed);
			console.log('END client');
		});
	}).listen(port, ip);
	console.log("Listening on ip: "+ip+" port: "+port);
}

function Channel(name, clientOperator) {
	this.name = name;
	this.clients = {};
	this.clientCount = 0;

	this.privileges = {}; // per user privileges
	if (clientOperator)
		this.addClientPrivilege(clientOperator, 'o');
}
Channel.validClientModes = ['o'];
Channel.prototype.addClientPrivilege = function(client, mode) {
	var privileges = this.privileges[client.guid];
	if (!privileges) this.privileges[client.guid] = privileges = {};

	if (mode.length == 1 && Channel.validClientModes.indexOf(mode) >= 0)
		privileges[mode] = true;
}
Channel.prototype.hasClientPrivilege = function(client, mode) {
	var privileges = this.privileges[client.guid];
	if (!privileges) return false;
	if (mode.length != 1) return false;

	return privileges[mode] == true;
}
Channel.prototype.listClients = function() {
	var result = [];
	for (var i in this.clients) {
		var client = this.clients[i];
		var name = client.nick;
		if (this.hasClientPrivilege(client, 'o'))
			name = '@'+name;
		result.push(name);
	}
	return result;
}
Channel.prototype.addClient = function(client) {
	console.log('Channel '+this.name+' JOIN client: '+client.nick);
	this.clients[client.guid] = client;
	// @TODO: send topic to client
	client.answerFrom('JOIN :'+this.name, client.getIdentifier());
	this.deliverFrom('JOIN :'+this.name, client.nick, client);
	this.sendUserList(client);
	this.clientCount += 1;
}
Channel.prototype.sendUserList = function(client) {
	client.answer('353 '+client.nick+' = '+this.name+' :'+this.listClients().join(' ')); // @TODO: add all nicks of channel
	client.answer('366 '+client.nick+' '+this.name+' :End of NAMES list');
}
Channel.prototype.removeClient = function(client) {
	console.log('Channel '+this.name+' PART client: '+client.nick);
	delete this.privileges[client.guid];
	delete this.clients[client.guid];
	client.answerFrom('PART :'+this.name, client.getIdentifier());
	this.deliverFrom('PART :'+this.name, client.nick, client);
	this.clientCount -= 1;
}
Channel.prototype.deliverFrom = function(message, str, opt_excludeClient) {
	this.deliver(':'+str+' '+message, opt_excludeClient);
}
Channel.prototype.deliver = function(message, opt_excludeClient) {
	for (var i in this.clients) {
		var c = this.clients[i];
		if (c == opt_excludeClient) continue; // Don't notify message owner
		c.write(message);
	}
}
Channel.prototype.deliverMessage = function(client, message) {
	// no answer to sending client
	this.deliverFrom('PRIVMSG '+this.name+' :'+message, client.getServerIdentifier(true), client);
}

function Client(socket, serverHostname) {
	this.socket = socket;
	this.serverHostname = (serverHostname == servHostname ? null : serverHostname);
	this.host = this.getRemoteAddress();
	this.requests = [];
	this.socketClosed = false;
	this.state = STATE.initial;
	this.channels = {};
	this.channelCount = 0;
	this.nick = null;
	this.guid = null;
}
Client.prototype.close = function() {
	this.socketClosed = true;
	if (this.socket)
		this.socket.destroy();
}
Client.prototype.write = function(data) {
	if (this.serverHostname) {
		// @TODO: handle remote hosts
	} else {
		if (this.socketClosed) return;
		console.log('<< '+data);
		return this.socket.write(data+'\r\n');
	}
}
Client.prototype.getRemoteAddress = function() {
	return this.socket.remoteAddress;
}
Client.prototype.sameServer = function() {
	return this.serverHostname == servHostname;
}
Client.prototype.getServerHostname = function() {
	if (this.serverHostname) return this.serverHostname;
	return servHostname;
}
Client.prototype.getServerIdentifier = function(bExtended) {
	return this.nick+(bExtended?'!~'+this.user:'')+'@'+this.getServerHostname();
}
Client.prototype.getIdentifier = function() {
	return this.nick+'!~'+this.user+'@'+this.getRemoteAddress();
}
Client.prototype.setNickName = function(nick) {
	this.nick = nick;
}
Client.prototype.sendWelcome = function() {
	this.answer('001 '+servHostname+' :Welcome to the fancy IRC server '+this.nick+'!'+this.user+'@'+this.getServerHostname());
	this.answer('002 '+servHostname+' :Your host is '+servHostname+' running version '+version);
	this.answer('003 '+servHostname+' :This server was created '+this.timeCreated);
	this.answer('004 '+servHostname+' '+servHostname+' '+version);
}
Client.prototype.addChannel = function(channel) {
	this.channels[channel.name] = channel;
	this.channelCount += 1;
}
Client.prototype.removeChannel = function(channel) {
	delete this.channels[channel.name];
	this.channelCount -= 1;
}
Client.prototype.answerSimple = function(str) {
	return this.write(str);
}
Client.prototype.answerFrom = function(str, from) {
	return this.write(':'+from+' '+str);
}
Client.prototype.answer = function(str) {
	this.answerFrom(str, this.getServerHostname());
}

