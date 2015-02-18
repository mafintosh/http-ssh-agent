# http-ssh-agent

Node.js [http agent](http://nodejs.org/api/http.html#http_class_http_agent) that allows you to send http requests over ssh.

	npm install http-ssh-agent

## Usage

Start a http server on a server that you have ssh access to. Since we will be accessing the server using ssh the server can bind to a port that is not open externally.
On your local machine you just create the agent with some ssh options and pass it to a http module.

### Using node core

``` js
var http = require('http')
var agent = require('http-ssh-agent')

// per default the agent will authenticate using ~/.ssh/id_rsa as your private key
var ssh = agent('username@example.com')

http.get({
	port: 8080,        // assuming the remote server is running on port 8080
	host: '127.0.0.1', // the host is resolved via ssh so 127.0.0.1 -> example.com
	agent: ssh         // simply pass the agent
}, function(response) {
	response.pipe(process.stdout)
})
```

### Using request

``` js
var request = require('request')

request('http://127.0.0.1:8080', {agent: ssh}).pipe(process.stdout)
```

### SSH options

Pass additional ssh options as the second argument. See [ssh2](https://github.com/mscdex/ssh2) connection options for a full list of available options.

``` js
var ssh = agent('username@example.com', {
	privateKey: 'path-to-private-key', // can also be a buffer,
	password: 'ssh-password'    // specify a password instead of a key
})
```

### Host verification

The agent will emit a `verify` event when it wants you to verify a host fingerprint.
You should validate that the fingerprint is correct and return an error if not.

``` js
ssh.on('verify', function(fingerprint, callback) {
	console.log('Server fingerprint is', fingerprint)
	callback() // pass an error to indicate a bad fingerprint
})
```

If you do not want to do host validation simply do not listen for the `verify` event.
You can also choose to pass the hash to challange against as the `verify` option.

## Running the tests

To run the tests you need to have a local ssh server running (on OSX enable `Remote login`) and have your own public key
whitelisted in `.ssh/authorized_keys`.

Then simply run

```
npm test
```

## License

MIT
