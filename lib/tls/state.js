var assert = require('assert');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var rfc3280 = require('asn1.js-rfc3280');
var Buffer = require('buffer').Buffer;

var tls = require('../tls');
var constants = tls.constants;
var utils = tls.utils;

function State(options) {
  EventEmitter.call(this);

  this.options = options || {};

  this.context = this.options.context;
  if (!this.context)
    throw new Error('Context is a required option when creating a socket');

  // Just a shortcut
  this.crypto = this.context.crypto;
  this.socket = this.options.socket;
  this.framer = tls.framer.create(this);
  this.parser = tls.parser.create(this);

  // General parameters
  this.type = this.options.type;
  this.minVersion = this.context.minVersion || 0x0301;
  this.maxVersion = this.context.maxVersion || 0x0303;
  this.version = this.type === 'client' ? this.minVersion : this.maxVersion;
  this.secure = false;

  // Pending error that should happen only after handshake
  this.pendingError = null;

  // TODO(indutny): more default ciphers?
  this.ciphers = this.options.ciphers || this.context.ciphers || [
    'TLS_RSA_WITH_AES_256_CBC_SHA'
  ];
  this.key = null;

  // State machine data
  this.wait = 'hello';
  this.initialWait = this.wait;
  this.skip = {};

  this.writeSession = new Session(this);
  this.readSession = new Session(this);
  this.pending = new Session(this);

  // Start recording messages
  this.pending.recordMessages();

  var self = this;
  this.framer.on('random', function(bytes) {
    self.setRandom(bytes);
  });

  this.framer.on('handshakeMsg', function(buffers) {
    self.pending.addHandshakeMessage(buffers);
  });

  this.framer.on('error', function(err) {
    // TODO(indutny): figure out errors in parser
    self._error(err.description || 'internal_error', err);
  });

  this.parser.on('error', function(err) {
    // TODO(indutny): figure out errors in parser
    self._error(err.description || 'unexpected_message', err);
  });
};
util.inherits(State, EventEmitter);
module.exports = State;

State.create = function create(options) {
  return new State(options);
};

State.prototype.start = function start() {
  if (this.type !== 'client')
    return;

  this.framer.hello('client', {
    maxVersion: this.maxVersion,
    session: this.pending.id,
    cipherSuites: this.getCipherSuites()
  });
};

State.prototype.handle = function handle(frame) {
  if (this.wait !== 'hello' && frame.version !== this.version)
    return this._error('protocol_version', 'Invalid version after handshake');

  // NOTE: We are doing it not in parser, because parser may parse more
  // frames that we have yet observed.
  // Accumulate state for `verifyData` hash
  // TODO(indutny) renegotiation
  if (!this.secure &&
      frame.type === 'handshake' &&
      frame.handshakeType !== 'hello_request') {
    this.pending.addHandshakeMessage(frame.rawBody.toChunks());
  }

  // Alert level protocol
  do {
    var start = this.wait;
    var handled = false;

    if (frame.type === 'alert')
      handled = this.handleAlert(frame);
    else if (frame.type === 'handshake')
      handled = this.handleHandshake(frame);
    else if (frame.type === 'change_cipher_spec')
      handled = this.handleChangeCipher(frame);
    else if (frame.type === 'application_data')
      handled = this.handleAppData(frame);

    if (start !== this.wait)
      this.emit('stateChange', start, this.wait);
  } while (handled === this.skip);

  return handled;
};

//
// Common parts
//

State.prototype.handleAlert = function handleAlert(frame) {
  if (frame.level === 'fatal') {
    var err = new Error('Received alert: ' + frame.description);
    this.emit('error', err);
    return true;
  }

  // EOF, handled by socket
  if (frame.description === 'close_notify')
    return true;

  // TODO(indutny): Handle not fatal alerts
  return true;
};

State.prototype.handleHandshake = function handleHandshake(frame) {
  if (this.type === 'client')
    return this.clientHandleHandshake(frame);
  else
    return this.serverHandleHandshake(frame);
};

State.prototype.handleChangeCipher = function handleChangeCipher() {
  // Parser already handles it
  return true;
};

State.prototype.handleAppData = function handleAppData(frame) {
  // App data is not allowed in handshake
  if (!this.secure)
    return false;

  // Handled in socket.js
  return true;
};

//
// Client methods
//

State.prototype.clientHandleHandshake = function clientHandleHandshake(frame) {
  var htype = frame.handshakeType;

  if (this.wait === 'hello') {
    if (htype !== 'server_hello')
      return false;

    if (!this.clientHandleHello(frame))
      return false;
  } else if (this.wait === 'certificate' || this.wait === 'optCertificate') {
    if (htype !== 'certificate') {
      if (this.wait === 'certificate')
        return false;

      this.wait = 'keyExchange';
      return this.skip;
    }

    if (!this.clientHandleCert(frame))
      return false;

    // TODO(indutny): DHE
    if (this.pending.info.dh === 'ecdhe')
      this.wait = 'ecdheKeyExchange';
    else
      this.wait = 'certReq';
  } else if (this.wait === 'ecdheKeyExchange') {
    if (htype !== 'server_key_exchange')
      return false;

    if (!this.clientHandleECDHEKeyEx(frame))
      return false;

    this.wait = 'certReq';
  } else if (this.wait === 'certReq') {
    if (htype !== 'certificate_request') {
      this.wait = 'helloDone';
      return this.skip;
    }

    this.wait = 'helloDone';
  } else if (this.wait === 'helloDone') {
    if (htype !== 'server_hello_done')
      return false;

    // Send verify data and clear messages
    if (!this.clientHandleHelloDone(frame))
      return false;

    this.wait = 'finished';
  } else if (this.wait === 'finished'){
    if (htype !== 'finished' || !this.bothSwitched())
      return false;

    if (!this.checkFinished(frame))
      return false;

    // TODO(indutny): renegotiation?
    this.wait = 'none';
    this.secure = true;
    this.emit('secure');
  } else {
    return false;
  }
  return true;
};

State.prototype.checkFinished = function checkFinished(frame) {
  if (!this.readSession.verify)
    return false;

  var expectedVerify = this.readSession.verify;
  this.readSession.verify = null;

  if (expectedVerify.length !== frame.verify.length)
    return this._error('bad_record_mac', 'Finished verify doesn\'t match');

  for (var i = 0; i < expectedVerify.length; i++) {
    if (expectedVerify[i] !== frame.verify[i])
      return this._error('bad_record_mac', 'Finished verify doesn\'t match');
  }

  return true;
};

State.prototype.clientHandleHello = function clientHandleHello(frame) {
  if (!this.negotiateVersion(frame.maxVersion) &&
      !this.negotiateVersion(frame.version)) {
    return this._error('protocol_version', 'Client failed to negotiate ver');
  }

  this.setReceivedRandom(frame.random);
  if (!this.selectCipherSuite([ frame.cipherSuite ]))
    return false;

  // TODO(indutny): support anonymous ciphers
  this.wait = 'certificate';

  return true;
};

State.prototype.clientHandleCert = function clientHandleCert(frame) {
  try {
    var certs = frame.certs.map(function(cert) {
      return rfc3280.Certificate.decode(cert, 'der');
    });
  } catch (e) {
    return this._error('bad_certificate', e);
  }

  var leaf = utils.getLeaf(this.crypto, certs);
  if (!leaf)
    return this._error('certificate_unknown', 'No leaf certificate available');

  this.key = {
    key: null,
    certs: frame.certs,
    leaf: leaf,
    pub: leaf.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey.data
  };
  this.emit('cert', leaf, frame.certs);

  return true;
};

State.prototype.clientHandleHelloDone = function clientHandleHelloDone(frame) {
  // Anonymous ciphers
  if (this.pending.info.auth === 'anon' || this.pending.info.auth === 'null')
    return true;

  // TODO(indutny): Certificate requests

  // TODO(indunty): async may be?

  // TODO(indutny): Support non-RSA ciphers
  // TODO(indutny): Support DHE?
  var res;
  if (this.pending.info.dh === 'ecdhe')
    res = this.clientECDHEKeyEx();
  else
    res = this.clientRSAKeyEx();
  if (!res)
    return false;

  this.changeCipherAndFinish();

  return true;
};

State.prototype.clientECDHEKeyEx = function clientECDHEKeyEx() {
  // Missing ServerKeyExchange
  // TODO(indutny): proper error?
  if (!this.pending.serverKeyEx)
    return false;

  var params = this.pending.serverKeyEx.params;

  try {
    var pairs = {
      client: this.crypto.genECDHEPair(params),
      server: this.crypto.toECDHEPub(params, this.pending.serverKeyEx.point)
    };

    var secret = this.crypto.deriveECDHE(pairs.client, pairs.server);
  } catch (e) {
    return this._error('internal_error', e);
  }

  this.pending.preMaster = secret;

  var pub = this.crypto.getECDHEPub(pairs.client);
  assert(pub.length <= 255);

  var content = new Buffer(pub.length + 1)
  content[0] = pub.length;
  pub.copy(content, 1);
  this.framer.keyExchange('client', content);

  return true;
};

State.prototype.clientRSAKeyEx = function clientRSAKeyEx() {
  if (this.pending.info.auth !== 'rsa')
    return false;

  var size = 46;
  var preMaster = new Buffer(2 + size);
  preMaster.writeUInt16BE(this.version, 0, true);
  this.crypto.random(46).copy(preMaster, 2);

  this.pending.preMaster = preMaster;

  var pub = this.crypto.toPublicKey(this.key.pub);
  var out = new Buffer(2 + pub.size());
  this.crypto.encryptPublic(out.slice(2),
                            preMaster,
                            pub);

  out.writeUInt16BE(out.length - 2, 0, true);
  this.framer.keyExchange('client', out);

  return true;
};

State.prototype.clientHandleECDHEKeyEx =
    function clientHandleECDHEKeyEx(frame) {
  var keyEx = this.parser.parseECDHEKeyEx(frame);
  if (!keyEx)
    return false;

  if (keyEx.params.type !== 'named_curve')
    return false;

  // Algorithms should match
  if (this.pending.info.auth !== keyEx.signature.signature)
    return this._error('bad_record_mac', 'Signature algorithm doesn\'t match');

  if (this.key === null)
    return false;

  // TODO(indutny): Figure out situations, where cert has different hash
  // function
  try {
    var rawParams = keyEx.rawParams.toChunks();
    var v = this.crypto.verify(keyEx.signature)
                       .update(this.pending.clientRandom)
                       .update(this.pending.serverRandom);

    for (var i = 0; i < rawParams.length; i++)
      v.update(rawParams[i]);

    v.verify(this.crypto.toVerifyKey(this.key.pub), keyEx.signature.content);
  } catch (e) {
    return this._error('bad_record_mac', e);
  }
  if (!v)
    return this._error('bad_record_mac', 'Bad signature');

  this.pending.serverKeyEx = keyEx;

  return true;
};

//
// Server methods
//

State.prototype.serverHandleHandshake = function serverHandleHandshake(frame) {
  var htype = frame.handshakeType;

  if (this.wait === 'hello') {
    if (htype !== 'client_hello')
      return false;

    if (!this.serverHandleHello(frame))
      return false;

    if (this.pending.info.dh === 'ecdhe')
      this.wait = 'ecdheKeyExchange';
    else
      this.wait = 'keyExchange';
  } else if (this.wait === 'certificate') {
    if (htype !== 'certificate') {
      this.wait = 'keyExchange';
      return this.skip;
    }

    this.wait = 'keyExchange';
  } else if (this.wait === 'ecdheKeyExchange') {
    if (htype !== 'client_key_exchange')
      return false;

    if (!this.serverHandleECDHEKeyEx(frame))
      return false;

    this.wait = 'certVerify';
  } else if (this.wait === 'keyExchange') {
    if (htype !== 'client_key_exchange')
      return false;

    if (!this.serverHandleRSAKeyEx(frame))
      return false;

    this.wait = 'certVerify';
  } else if (this.wait === 'certVerify') {
    if (htype !== 'certificate_verify') {
      this.wait = 'finished';
      return this.skip;
    }

    this.wait = 'finished';
  } else if (this.wait === 'finished') {
    // TODO(indutny): renegotiation?
    if (htype !== 'finished' || this.bothSwitched())
      return false;

    if (!this.checkFinished(frame))
      return false;

    this.changeCipherAndFinish();

    if (this.pendingError) {
      return this._error(this.pendingError.description,
                         this.pendingError.message);
    }

    // TODO(indutny): renegotiation?
    this.wait = 'none';
    this.secure = true;
    this.emit('secure');
  } else {
    return false;
  }

  return true;
};

State.prototype.serverHandleHello = function serverHandleHello(frame) {
  if (!this.negotiateVersion(frame.maxVersion) &&
      !this.negotiateVersion(frame.version)) {
    return this._error('protocol_version', 'Server failed to negotiate ver');
  }

  var cipher = this.selectCipherSuite(frame.cipherSuites);
  if (!cipher)
    return false;

  this.setReceivedRandom(frame.random);
  this.framer.hello('server', {
    cipherSuite: cipher
  });

  if (this.key !== null)
    this.framer.certificate(this.key.certs);

  // TODO(indutny): Server key exchange for DHE, CertificateRequest
  var res = true;
  if (this.pending.info.dh === 'ecdhe')
    res = this.serverECDHEKeyEx(frame);
  if (!res)
    return false;

  this.framer.helloDone();

  return true;
};

State.prototype.serverECDHEKeyEx = function serverECDHEKeyEx(hello) {
  if (this.key === null)
    return this._error('internal_error', 'No key found');

  // TODO(indutny): Support ECDSA signatures
  if (this.pending.info.auth !== 'rsa')
    return false;

  // TODO(indutny): Use curves from hello
  var params = {
    type: 'named_curve',
    value: this.context.curve
  };
  try {
    this.pending.serverKeyEx = {
      params: params,
      private: this.crypto.genECDHEPair(params)
    };
  } catch (e) {
    return this._error('internal_error', e);
  }

  var pub = this.crypto.getECDHEPub(this.pending.serverKeyEx.private);
  var content = this.framer.ECDHEServerKeyEx(params, pub);
  if (!content)
    return false;

  var sparams = {
    signature: this.pending.info.auth,

    // NOTE: TLS < 1.2 is using forced md5-sha1
    hash: this.version >= 0x0303 ? 'sha1' : 'md5-sha1'
  };

  var sign = this.crypto.sign(sparams)
                        .update(this.pending.clientRandom)
                        .update(this.pending.serverRandom)
                        .update(content)
                        .sign(this.key.pem);
  var s = this.framer.signature(sparams, sign);
  if (!s)
    return false;

  var out = Buffer.concat([ content, s ], content.length + s.length);
  this.framer.keyExchange('server', out);
  return true;
};

State.prototype.serverHandleRSAKeyEx = function serverHandleRSAKeyEx(frame) {
  if (this.key === null)
    return false;

  var keyEx = this.parser.parseRSAKeyEx(frame);
  if (!keyEx)
    return false;

  this.pending.preMaster = new Buffer(this.key.key.size());
  try {
    this.pending.preMaster = this.crypto.decryptPrivate(this.pending.preMaster,
                                                        keyEx,
                                                        this.key.key);
  } catch (e) {
    return this._error('decrypt_error', e);
  }

  if (this.pending.preMaster.length !== 48)
    return this._error('decrypt_error', 'RSA preMaster invalid length');

  if (this.pending.preMaster.readUInt16BE(0, true) !== this.version) {
    // Do not fail immediately, see Appendix D.4 RFC 5246
    // (Bleichenbacher attack)
    this.pendingError = {
      description: 'protocol_version',
      message: 'client_key_exchange version mismatch'
    };
  }

  return true;
};

State.prototype.serverHandleECDHEKeyEx =
    function serverHandleECDHEKeyEx(frame) {
  var point = this.parser.parseECDHEClientKeyEx(frame);
  if (!point)
    return false;

  var params = this.pending.serverKeyEx.params;
  try {
    var pairs = {
      server: this.pending.serverKeyEx.private,
      client: this.crypto.toECDHEPub(params, point)
    };

    var secret = this.crypto.deriveECDHE(pairs.server, pairs.client);
  } catch (e) {
    return this._error('internal_error', e);
  }

  this.pending.preMaster = secret;

  return true;
};

//
// Routines
//

State.prototype._error = function error(description, msg) {
  this.framer.alert('fatal', description);

  var err = msg instanceof Error ? msg : new Error(msg);
  this.emit('error', err);

  return false;
};

State.prototype.changeCipherAndFinish = function changeCipherAndFinish() {
  // Send verify data and clear messages
  this.framer.changeCipherSpec();

  // NOTE: Fetch verify data before clearing the states
  var verifyData;

  // All consecutive writes will be encrypted
  var self = this;
  this.switchToPending('write', function() {
    verifyData = self.getVerifyData('write');

    if (verifyData)
      self.framer.finished(verifyData);
    else
      self._error('unexpected_message', 'Session is not initialized');
  });
};

State.prototype.shouldDecrypt = function shouldDecrypt() {
  return this.readSession.decipher !== null;
};

State.prototype.decrypt = function decrypt(body, header) {
  var session = this.readSession;

  // Decipher data
  var out = new Buffer(body.length);
  session.decipher.write(out, body);

  if (session.info.bulk.cbc) {
    // Remove padding
    var pad = out[out.length - 1];
    if (out.length <= pad + 1)
      throw new Error('Padding OOB');

    for (var i = out.length - pad - 1; i < out.length; i++)
      if (out[i] !== pad)
        throw new Error('Padding bytes are invalid');

    // 1-byte size prefix
    pad += 1;

    // Get MAC
    var macLen = session.macKeyLength;
    var macOff = out.length - pad - macLen;

    // Get data
    var res = out.slice(session.recordIVLength, macOff);
  } else if (session.info.type === 'stream') {
    var macLen = session.macKeyLength;
    var macOff = out.length - session.macKeyLength;

    var res = out.slice(0, -macLen);
  } else {
    throw new Error('Unsupported cipher type');
  }

  // Compute expeted MAC
  // 1 - type
  // 2 - version
  // 2 - length
  var pre = new Buffer(5);
  header.buffer.copy(pre, 0, 0, 3);
  pre.writeUInt16BE(res.length, 3, true);

  // TODO(indutny): Fix side-channel leak
  var expectedMac = session.mac(session.macReadKey)
      .update(session.readSeq)
      .update(pre)
      .update(res)
      .digest('buffer');
  utils.incSeq(session.readSeq);

  if (expectedMac.length !== macLen)
    throw new Error('Invalid MAC');

  for (var i = 0; i < macLen; i++)
    if (out[macOff + i] !== expectedMac[i])
      throw new Error('Invalid MAC');

  return res;
};

State.prototype.shouldEncrypt = function shouldEncrypt() {
  return this.writeSession.cipher !== null;
};

State.prototype.encrypt = function encrypt(body, hdr) {
  var content = body.length === 1 ? body[0] : Buffer.concat(body);
  var session = this.writeSession;

  // Compute MAC
  /*
   * MAC(MAC_write_key, seq_num +
   *                    TLSCompressed.type +
   *                    TLSCompressed.version +
   *                    TLSCompressed.length +
   *                    TLSCompressed.fragment);
   */
  var mac = session.mac(session.macWriteKey)
      .update(session.writeSeq)
      .update(hdr)
      .update(content)
      .digest('buffer');
  utils.incSeq(session.writeSeq);

  var bulkSize = session.bulkSize;
  var length = content.length;
  var padLen = 0;
  if (session.info.bulk.cbc) {
    length += session.recordIVLength;
    length += session.macKeyLength;

    // Padding length byte
    length += 1;

    // Padding length
    if (length % bulkSize !== 0)
      padLen = bulkSize - (length % bulkSize);
    else
      padLen = 0;
    length += padLen;
  } else if (session.info.type === 'stream') {
    length += session.macKeyLength;
  } else {
    throw new Error('Unsupported cipher type');
  }

  // NOTE: Updates length in real record header
  hdr.writeUInt16BE(length, 3, true);

  if (session.info.bulk.cbc) {
    /*
     * struct {
     *      opaque IV[SecurityParameters.record_iv_length];
     *      block-ciphered struct {
     *          opaque content[TLSCompressed.length];
     *          opaque MAC[SecurityParameters.mac_length];
     *          uint8 padding[GenericBlockCipher.padding_length];
     *          uint8 padding_length;
     *      };
     *  } GenericBlockCipher;
     */
    var pad = new Buffer(padLen + 1);
    pad.fill(pad.length - 1);

    var iv = this.crypto.random(session.recordIVLength);

    var inp = Buffer.concat([
      iv,
      content,
      mac,
      pad
    ], iv.length + content.length + mac.length + pad.length);
  } else if (session.info.type === 'stream') {
    /*
     * stream-ciphered struct {
     *     opaque content[TLSCompressed.length];
     *     opaque MAC[SecurityParameters.mac_length];
     * } GenericStreamCipher;
     */
    var inp = Buffer.concat([ content, mac ], content.length + mac.length);
  } else {
    throw new Error('Unsupported cipher type');
  }

  var out = new Buffer(inp.length);
  session.cipher.write(out, inp);
  return [ out ];
};

State.prototype.switchToPending = function switchToPending(side, cb) {
  if (side === 'read')
    this.readSession = this.pending;
  else
    this.writeSession = this.pending;

  this.pending.computeMaster();

  if (cb)
    cb();

  if (side === 'read')
    this.pending.verify = this.getVerifyData('read');

  // Reset state
  if (this.readSession === this.pending && this.writeSession === this.pending) {
    this.pending.clearMessages();
    this.pending = new Session(this);
  }

  return true;
};

State.prototype.bothSwitched = function bothSwitched() {
  return this.readSession === this.writeSession;
};

State.prototype.setRandom = function setRandom(bytes) {
  if (this.type === 'client')
    this.pending.clientRandom = bytes;
  else
    this.pending.serverRandom = bytes;
};

State.prototype.setReceivedRandom = function setReceivedRandom(bytes) {
  if (this.type === 'client')
    this.pending.serverRandom = bytes;
  else
    this.pending.clientRandom = bytes;
};

State.prototype.getCipherSuites = function getCipherSuites() {
  return this.ciphers;
};

State.prototype.selectCipherSuite = function selectCipherSuite(ciphers) {
  for (var i = 0; i < this.ciphers.length; i++) {
    var our = this.ciphers[i];
    for (var j = 0; j < ciphers.length; j++) {
      var their = ciphers[j];
      if (our !== their)
        continue;

      var cipher = our;

      this.pending.load(this.crypto, cipher);

      // TODO(indunty): Support ECDSA
      if (this.pending.info.auth !== 'rsa')
        return false;

      if (this.pending.info.version.min > this.version)
        continue;

      this.key = this.context.keys[this.pending.info.auth] || null;
      return cipher;
    }
  }

  return false;
};

State.prototype.getVerifyData = function getVerifyData(side) {
  var session = side === 'read' ? this.readSession : this.writeSession;

  // Not initialized
  if (session.prf === null ||
      session.mac === null ||
      session.masterSecret === null) {
    return null;
  }

  var label;
  if (this.type === 'client' && side === 'write' ||
      this.type === 'server' && side === 'read') {
    label = constants.prf.clientFin;
  } else {
    label = constants.prf.serverFin;
  }

  return new session.prf(session.masterSecret,
                         label,
                         [ session.hashMessages() ])
                    .read(session.info.verifyLength);
};

State.prototype.negotiateVersion = function negotiateVersion(v) {
  if (v < this.minVersion || v > this.maxVersion)
    return false;

  this.version = v;

  return true;
};

//
// Dummy state
//
function Dummy(options) {
  this.crypto = options.provider;

  this.sides = {
    read: { encrypted: false },
    write: { encrypted: false }
  };

  this.version = 0x0303;
}

Dummy.prototype.switchToPending = function switchToPending(side, cb) {
  this.sides[side].encrypted = true;
  if (cb)
    cb();
};

Dummy.prototype.shouldDecrypt = function shouldDecrypt() {
  return this.sides.read.encrypted;
};

Dummy.prototype.decrypt = function decrypt(body) {
  throw new Error('Dummy can\'t decrypt');
};

Dummy.prototype.shouldEncrypt = function shouldEncrypt() {
  return this.sides.write.encrypted;
};

Dummy.prototype.encrypt = function encrypt(body) {
  throw new Error('Dummy can\'t encrypt');
};

State.Dummy = Dummy;
State.createDummy = function createDummy(options) {
  return new Dummy(options);
};

// Session details

function Session(state) {
  this.state = state;
  this.id = null;

  var seqs = new Buffer(16);
  this.readSeq = seqs.slice(0, 8);
  this.readSeq.fill(0);
  this.writeSeq = seqs.slice(8, 16);
  this.writeSeq.fill(0);

  this.info = null;
  this.prf = null;
  this.cipher = null;
  this.decipher = null;
  this.cipherAlg = null;
  this.decipherAlg = null;
  this.keyLength = 0;
  this.macKeyLength = 0;
  this.fixedIVLength = 0;
  this.recordIVLength = 0;
  this.mac = null;
  this.compression = null;
  this.preMaster = null;
  this.masterSecret = null;
  this.clientRandom = null;
  this.serverRandom = null;
  this.verify = null;
  this.hash = null;

  // Keys
  this.clientWriteMacKey = null;
  this.serverWriteMacKey = null;
  this.macReadKey = null;
  this.macWriteKey = null;
  this.clientWriteKey = null;
  this.serverWriteKey = null;
  this.clientWriteIV = null;
  this.serverWriteIV = null;

  // Key Exchange
  this.clientKeyEx = null;
  this.serverKeyEx = null;

  // Various
  this.bulkSize = 0;

  // All messages in this handshake
  this.recording = false;
  this.handshakeMessages = [];
};

Session.prototype.computeMaster = function computeMaster() {
  // Already initialized
  if (this.masterSecret !== null)
    return;

  var secrets = utils.deriveSecrets(this.info,
                                    this.prf,
                                    this.preMaster,
                                    this.clientRandom,
                                    this.serverRandom);

  this.masterSecret = secrets.master;

  this.clientWriteMacKey = secrets.client.mac;
  this.serverWriteMacKey = secrets.server.mac;
  this.clientWriteKey = secrets.client.key;
  this.serverWriteKey = secrets.server.key;
  this.clientWriteIV = secrets.client.iv;
  this.serverWriteIV = secrets.server.iv;

  if (this.state.type === 'client') {
    this.cipher = this.cipherAlg(this.clientWriteKey, this.clientWriteIV);
    this.decipher = this.decipherAlg(this.serverWriteKey, this.serverWriteIV);
    this.macWriteKey = this.clientWriteMacKey;
    this.macReadKey = this.serverWriteMacKey;
  } else {
    this.cipher = this.cipherAlg(this.serverWriteKey, this.serverWriteIV);
    this.decipher = this.decipherAlg(this.clientWriteKey, this.clientWriteIV);
    this.macReadKey = this.clientWriteMacKey;
    this.macWriteKey = this.serverWriteMacKey;
  }
};

Session.prototype.load = function load(crypto, cipher) {
  var info = constants.cipherInfoByName[cipher];

  var isTLS12 = this.state.version >= 0x0303;

  this.info = info;
  if (isTLS12) {
    if (crypto.prf)
      this.prf = crypto.prf(info.prf);
    else
      this.prf = utils.prf(crypto.mac(info.prf));
  } else {
    if (crypto.prf)
      this.prf = crypto.prf('md5/sha1');
    else
      this.prf = utils.ssl3prf(crypto);
  }
  this.cipherAlg = crypto.cipher(info.bulk);
  this.cipher = null;
  this.decipherAlg = crypto.decipher(info.bulk);
  this.decipher = null;
  this.keyLength = info.bulk.keySize / 8;
  this.bulkSize = info.bulk.size / 8;
  this.mac = crypto.mac(info.mac);
  this.hash = isTLS12 ? crypto.hash(info.prf) :
                        (crypto.ssl3hash || utils.ssl3hash)(crypto);
  this.macKeyLength = info.macSize / 8;
  this.fixedIVLength = info.bulk.ivSize / 8;

  // TODO(indunty): what about rest?
  if (this.state.version >= 0x0302 && info.type === 'block')
    this.recordIVLength = this.bulkSize;
  else
    this.recordIVLength = 0;
};

Session.prototype.recordMessages = function recordMessages() {
  this.recording = true;
};

Session.prototype.clearMessages = function clearMessages() {
  this.recording = false;
  this.handshakeMessages = [];
};

Session.prototype.hashMessages = function hashMessages() {
  var hash = this.hash();
  for (var i = 0; i < this.handshakeMessages.length; i++)
    hash.update(this.handshakeMessages[i]);
  return hash.digest('buffer');
};

Session.prototype.addHandshakeMessage = function addHandshakeMessage(buffers) {
  // TODO(indutny): Write into hashing function, once it will be available
  if (!this.recording)
    return;

  for (var i = 0; i < buffers.length; i++)
    this.handshakeMessages.push(buffers[i]);
};
