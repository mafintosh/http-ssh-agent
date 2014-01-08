var http = require('http');
var Connection = require('ssh2');
var thunky = require('thunky');
var pump = require('pump');
var stream = require('stream');
var fs = require('fs');
var path = require('path');
var net = require('net');
var util = require('util');

var HOME = process.env.HOME || process.env.USERPROFILE;

var Socket = function(opts) {
	stream.Duplex.call(this, opts);

	this.input = new stream.PassThrough();
	this.output = new stream.PassThrough();
	this.destroyed = false;
	this.reading = 0;

	var self = this;
	this.output.on('readable', function() {
		if (self.reading) self._read(self.reading);
	});

	this.input.destroy = this.output.destroy = this.destroy.bind(this);
};

util.inherits(Socket, stream.Duplex);

Socket.prototype.destroy = function(err) {
	if (this.destroyed) return;
	this.destroyed = true;

	var self = this;
	process.nextTick(function() {
		if (err) self.emit('error', err);
		self.emit('close');
		self.input.emit('close');
		self.output.emit('close');
	});
};

Socket.prototype._write = function(data, enc, cb) {
	return this.input.write(data, enc, cb);
};

Socket.prototype._read = function(n) {
	this.reading = 0;
	var data = this.output.read(n);
	if (data) return this.push(data);
	this.reading = n;
};


var agent = function(host, opts) {
	if (typeof host === 'object' && host) return agent(null, host);
	if (!opts) opts = {};

	if (host) {
		var parts = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		opts.username = parts[1] || 'root';
		opts.host = parts[2];
		opts.port = parseInt(parts[3] || 22, 10);
	}

	opts.privateKey = opts.key || opts.privateKey || path.join('~', '.ssh', 'id_rsa');

	var hwm = opts.highWaterMark;
	var a = new http.Agent();
	var refs = 0;

	var connect = thunky(function(cb) {
		var c = new Connection();

		c.on('error', cb);
		c.on('ready', function() {
			cb(null, c);
		});

		var ready = function() {
			c.connect(opts);
		};

		if (Buffer.isBuffer(opts.privateKey)) return ready();

		fs.readFile(opts.privateKey.replace(/^~/, HOME), function(err, key) {
			if (err) return cb(err);
			opts.privateKey = key;
			ready();
		});
	});

	a.createConnection = function(opts) {
		var socket = new Socket(hwm ? {highWaterMark:hwm} : {});

		connect(function(err, con) {
			if (err) return d.destroy(err);

			refs++;

			var update = function() {
				var sock = con._sock;
				var pinger = con._pinger;

				if (refs) {
					if (sock && sock.ref) sock.ref();
					if (pinger && pinger.ref) pinger.ref();
				} else {
					if (sock && sock.unref) sock.unref();
					if (pinger && pinger.unref) pinger.unref();
				}
			};

			var unref = function() {
				refs--;
				update();
			};

			update();
			con.forwardOut('127.0.0.1', 8000, opts.host, opts.port, function(err, stream) {
				if (err) {
					socket.destroy(err);
					unref();
				} else {
					pump(socket.input, stream, socket.output, unref);
				}
			});
		});

		socket.on('data', function(data) {
			if (socket.ondata) socket.ondata(data, 0, data.length);
		});

		socket.on('end', function() {
			if (socket.onend) socket.onend();
		});

		return socket;
	};

	return a;
};

module.exports = agent;