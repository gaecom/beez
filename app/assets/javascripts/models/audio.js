
beez.Audio = Backbone.Model.extend({
  initialize: function () {
    this.ctx = new webkitAudioContext();
    this.seq = new beez.Sequence({
      ctx: this.ctx
    });
  },

  start: function () {
    this.output.connect(this.ctx.destination);
    this.seq.play();
  },

  stop: function () {
    this.output.disconnect(this.ctx.destination);
    this.seq.stop();
  },

  toggle: function (cb) {
    if (this.seq.isPlaying) {
      this.stop();
    } else {
      this.start();
      cb && cb();
    }
  },

  bindParam: function (param, audioParam) {
    param.on("change:value", function (m, value) {
      audioParam.value = value;
    });
    audioParam.value = param.get("value");
  },

  init: function () {
    var ctx = this.ctx,
      self = this;

    beez.params.get("bpm").on("change:value", function (m, value) {
      self.seq.set("bpm", value);
    });
    this.seq.set("bpm", beez.params.get("bpm").get("value"));

    var carrier = ctx.createOscillator();

    carrier.type = "triangle";
    //this.bindParam(beez.params.get("carrierfreq"), carrier.frequency);
    var carrierGain = ctx.createGainNode();
    this.bindParam(beez.params.get("carriergain"), carrierGain.gain);
    carrier.connect(carrierGain);

    var mod = ctx.createOscillator();
    mod.type = "sine";
    mod.detune.value = 8;
    var modGain = ctx.createGainNode();
    this.bindParam(beez.params.get("modgain"), modGain.gain);
    mod.start(0);
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    var filter = ctx.createBiquadFilter();
    this.bindParam(beez.params.get("filterfreq"), filter.frequency);
    this.bindParam(beez.params.get("filterQ"), filter.Q);
    carrierGain.connect(filter);

    // Reverbation now!
    var reverb = (function (nodeInput) {
      var input = ctx.createGain();
      nodeInput.connect(input);
      var output = ctx.createGain();
      var drygain = ctx.createGain();
      var wetgain = ctx.createGain();

      // Feedback delay into itself
      var verb = ctx.createConvolver();

      verb.connect(wetgain);

      input.connect(verb);
      input.connect(drygain);

      drygain.connect(output);
      wetgain.connect(output);

      this.bindParam(beez.params.get("reverbwet"), wetgain.gain);
      this.bindParam(beez.params.get("reverbdry"), drygain.gain);

      buildImpulse(1);

      function buildImpulse (time) {
            // FIXME: need the audio context to rebuild the buffer.
         var rate = ctx.sampleRate,
            length = rate * time,
            reverse = false,
            decay = 2,
            impulse = ctx.createBuffer(2, length, rate),
            impulseL = impulse.getChannelData(0),
            impulseR = impulse.getChannelData(1);
        for (var i = 0; i < length; i++) {
          var n = reverse ? length - i : i;
          impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
          impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
        }
        verb.buffer = impulse;
      }

      return output;
    }).call(this, filter);

    carrier.start(0);

    var compressor = ctx.createDynamicsCompressor();
    reverb.connect(compressor);

    this.output = compressor;

    this.seq.on("schedule", function (noteFreq, time) {
      var multiplicator = Math.round(4*beez.params.get("modmult").get("value"))/4;
      carrier.frequency.setValueAtTime(noteFreq, time);
      mod.frequency.setValueAtTime(noteFreq*multiplicator, time);
    }, this);

  }
});
