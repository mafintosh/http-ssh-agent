var http = require('http');
var Connection = require('ssh2');
var duplexer2 = require('duplexer2');
var thunky = require('thunky');
var pump = require('pump');
var stream = require('stream');
var fs = require('fs');
var path = require('path');
var net = require('net');

var agent = function(host, opts) {
	if (typeof host === 'object' && host) return agent(null, host);
	if (!opts) opts = {};

	if (host) {
		var parts = host.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
		opts.username = parts[1] || 'root';
		opts.host = parts[2];
		opts.port = parseInt(parts[3] || 22, 10);
	}

	opts.privateKey = opts.key || opts.privateKey || path.join(process.env.HOME || process.env.USERPROFILE, '.ssh', 'id_rsa');

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

		fs.readFile(opts.privateKey, function(err, key) {
			if (err) return cb(err);
			opts.privateKey = key;
			ready();
		});
	});

	a.close = function() {
		connect(function(err, con) {
			if (err) return;
			con.end();
		});
	};

	a.createConnection = function(opts) {
		var input = new stream.PassThrough();
		var output = new stream.PassThrough();
		var d = duplexer2(input, output);
		var destroyed = false;

		d.destroy = function(err) {
			if (destroyed) return;
			destroyed = true;

			if (err) d.emit('error', err);

			process.nextTick(function() {
				d.emit('close');
				input.emit('close');
				output.emit('close');
			});
		};

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
					d.destroy(err);
					unref();
				} else {
					pump(input, stream, output, unref);
				}
			});
		});

		d.on('data', function(data) {
			if (d.ondata) d.ondata(data, 0, data.length);
		});

		d.on('end', function() {
			if (d.onend) d.onend();
		});

		return d;
	};

	return a;
};

module.exports = agent;