(function(){
// FIXME: clean code, make it more Backbone compatible, improve the connect/disconnect event.

function trace(text) {
    // console.log(((new Date()).getTime() / 1000) + ": " + text);
}

function logError(error) {
    console.error(error);
}

beez.Peer = Backbone.Model.extend({
    options: {
      servers: {"iceServers":[{"url":"stun:stun.l.google.com:19302"}]}
    },
    initialize: function(options) {
        console.log("new Peer: ", options);
        this.on("message", this.onmessage, this);
        this.localPeerConnection = null;
        this.createConnection(options.isinitiator);
        //this.sendChannel = null;
    },
    createConnection: function(isinitiator) {
      var servers = this.get("servers");
      this.localPeerConnection = new webkitRTCPeerConnection(servers,{optional: [{RtpDataChannels: true}]});
      trace('Created local peer connection object localPeerConnection');

      this.localPeerConnection.onicecandidate = _.bind(this.gotLocalCandidate, this);
      //alert("createConnection")
      if (isinitiator) {
        try {
          // Reliable Data Channels not yet supported in Chrome
            this.sendChannel = this.localPeerConnection.createDataChannel("sendDataChannel",{reliable: false});
          trace('Created send data channel');
        } catch (e) {
          alert('Failed to create data channel. ' +
                'You need Chrome M25 or later with RtpDataChannel enabled');
          trace('createDataChannel() failed with exception: ' + e.message);
        }

        this.sendChannel.onopen = _.bind(this.handleSendChannelStateChange, this);
        this.sendChannel.onclose = _.bind(this.handleSendChannelStateChange, this);
        this.sendChannel.onmessage = _.bind(this.handleMessage, this);

        this.localPeerConnection.createOffer(_.bind(this.gotLocalDescription, this));
      } else {
          this.localPeerConnection.ondatachannel = _.bind(this.gotReceiveChannel, this);
      }
    },
    onmessage: function(json) {
        var data = JSON.parse(json);
        var self = this;
        if (data.sdp) {
            trace("onmessage: Session description received, set it: " + JSON.stringify(data.sdp));
            this.localPeerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp), function () {

                    trace("onmessage: setRemoteDescription callback: " + self.localPeerConnection.remoteDescription.type);
                    // if we received an offer, we need to answer
                    if (self.localPeerConnection.remoteDescription.type == "offer") {
                        trace("Create answer");
                        self.localPeerConnection.createAnswer(_.bind(self.onLocalDescriptionGenerated, self), logError);
                    }
                }, logError);
        } else if (data.candidate) {
            trace("onmessage: New candidate: " + JSON.stringify(data.candidate));
            this.localPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            logError("Unknow data" + data);
        }
    },
    signalingChannelSend: function(data) {
      this.get("wssend")(this.id, data);
    },
    // Send stuff
    gotLocalDescription: function (desc) {
      var self = this;
      //console.log("gotLocalDescription",this)
      this.localPeerConnection.setLocalDescription(desc, function() {
        self.signalingChannelSend(JSON.stringify({ "sdp": self.localPeerConnection.localDescription }));
      }, logError);
      trace('Offer from localPeerConnection \n' + desc.sdp);
    },

    gotLocalCandidate: function (event) {
      trace('gotLocalCandidate local ice callback');
      if (event.candidate) {
        trace('Local ICE candidate: \n' + event.candidate.candidate);
        this.signalingChannelSend(JSON.stringify({ "candidate": event.candidate }));
      }
    },

    handleMessage: function (event) {
      trace('Received message: ' + event.data);
      this.trigger("rtcmessage", JSON.parse(event.data), this);
    },

    handleSendChannelStateChange: function () {
      var readyState = this.sendChannel.readyState;
      this.trigger(readyState);
      trace('Send channel state is: ' + readyState);
    },
    // For not initiator only
    gotReceiveChannel: function (event) {
        trace('Receive Channel Callback, OK');
        this.sendChannel = event.channel;
        this.sendChannel.onmessage = _.bind(this.handleMessage, this);
        this.sendChannel.onopen = _.bind(this.handleSendChannelStateChange, this);
        this.sendChannel.onclose = _.bind(this.handleSendChannelStateChange, this);
    },
    onLocalDescriptionGenerated: function (desc) {
        var self = this;
        this.localPeerConnection.setLocalDescription(desc, function() {
            self.signalingChannelSend(JSON.stringify({ "sdp": self.localPeerConnection.localDescription }));
        }, logError);
    },
    send: function(data) {
        //console.log("RTC send message", data);
        this.sendChannel.send(JSON.stringify(data));
    }
});

beez.WebSocketControl = Backbone.Model.extend({
  initialize: function () {
    this.ws = new WebSocket(this.get("url"));
    this.ws.onclose = _.bind(this.onclose, this);
    this.ws.onopen = _.bind(this.onopen, this);
    this.ws.onmessage = _.bind(this.onmessage, this);
  },
  onopen: function () {
    this.trigger("open");
  },
  onclose: function () {
    this.trigger("close");
  },
  onmessage: function(event) {
    var json = JSON.parse(event.data);
    this.trigger("receive", json);
    if (json.e) {
      this.trigger("receive-"+json.e, json);
    }
  },
  send: function(jsObject) {
    this.ws.send(JSON.stringify(jsObject));
  },
  wssend: function(id, json) {
    this.ws.send(JSON.stringify({ "to": id, "data": json }));
  }
});

beez.HiveBroker = Backbone.Model.extend({
    initialize: function () {
        this.peers = new Backbone.Collection();
        this.ws = new WebSocket(this.get("wsUrl"));
        this.ws.onclose = _.bind(this.onclose, this);
        this.ws.onopen = _.bind(this.onopen, this);
        this.ws.onmessage = _.bind(this.onmessage, this);
    },
    onopen: function () {
      trace("WS open");
      this.trigger("connect");
    },
    onclose: function () {
      trace("WS close");
      this.trigger("disconnect");
    },
    onmessage: function(event) {
        trace('Hive: receive json '+event.data)
        var json = JSON.parse(event.data);
        var peer = this.peers.get(json.from);

        if (peer) {
            peer.trigger("message", json.data);
        } else {
            var peer = new beez.Peer({
              id: json.from,
              wssend: _.bind(this.wssend, this),
              isinitiator: false
            });
            this.peers.add(peer);
            peer.on("rtcmessage", function (message) {
              this.trigger("data", message);
            }, this);
            peer.trigger("message", json.data);
        }
    },
    wssend: function(id, json) {
        //console.log("send data over websocket: ", {"to": id, "data": json});

        this.ws.send(JSON.stringify( {"to": id, "data": json} ));
    },
    send: function (json) {
      this.peers.each(function (peer) {
        peer.send(json);
      });
    }
});

beez.BeePeerBroker = Backbone.Model.extend({
    initialize: function () {
        this.ws = new WebSocket(this.get("wsUrl"));
        this.ws.onclose = _.bind(this.onclose, this);
        this.ws.onopen = _.bind(this.onopen, this);
        this.ws.onmessage = _.bind(this.onmessage, this);
    },
    onopen: function () {
      trace("WS open");
      this.peer = new beez.Peer({
        id: this.get("id"),
        wssend: _.bind(this.wssend, this),
        isinitiator: true
      });
      this.peer.on("rtcmessage", function (message) {
        this.trigger("data", message);
      }, this);
      this.trigger("connect");
    },
    onclose: function () {
      trace("WS close");
      this.trigger("disconnect");
    },
    onmessage: function(event) {
        var json = JSON.parse(event.data);
        //console.log('BeePeerBroker: receive json ', json);

        this.peer.trigger("message", json.data);
    },
    wssend: function(id, json) {
        trace("send data over websocket: " + JSON.stringify(json));
        this.ws.send(JSON.stringify( {"to": this.get("id"), "data": json} ));
    },
    send: function(json) {
      try {
        this.peer.send(json);
      } catch(e) {}
    }
});

}());
