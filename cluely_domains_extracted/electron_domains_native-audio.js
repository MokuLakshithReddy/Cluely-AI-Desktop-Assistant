//#region electron/domains/native-audio.ts
var ty;
(function(t) {
	let n = null, r = null;
	function i() {
		process.platform !== "darwin" && (c(), l());
		let t = process.platform === "darwin" ? e.join(Jv, "sox-14.4.2-macosx") : e.join(Jv, "sox-14.4.1-win32"), n = $v();
		process.env[n] = [t, process.env[n]].join(e.delimiter), o(Q.getSharedState());
	}
	t.init = i;
	function o(e) {
		try {
			if (!e.session) {
				n?.destroy(), n = null, r?.destroy(), r = null;
				return;
			}
			n ||= new u(), process.platform === "darwin" && !r && (r = new d());
		} catch (e) {
			_.error("Error initializing NativeAudio services:", e), ey.requireErrorRestart();
		}
	}
	t.update = o;
	let s = 48e3;
	function c() {
		m.defaultSession.setDisplayMediaRequestHandler((e, t) => {
			a.getSources({ types: ["screen"] }).then((e) => {
				let n = e[0];
				if (!n) {
					t({});
					return;
				}
				t({
					video: n,
					audio: "loopback"
				});
			}).catch((e) => {
				_.error("[NativeAudio] Error selecting display media source:", e), t({});
			});
		});
	}
	function l() {
		let e = () => {
			Z.broadcastIpc("chat-display-media-sources-changed");
		};
		p.on("display-added", e), p.on("display-removed", e), p.on("display-metrics-changed", e);
	}
	class u {
		recording;
		isDestroyed = !1;
		constructor() {
			this.recording = O.record({
				channels: 1,
				sampleRate: s,
				audioType: "wav"
			}), this.recording.stream().on("data", (e) => {
				this.isDestroyed || Z.broadcastIpc("chat-audio-data", {
					role: "me",
					chunk: e
				});
			}), this.recording.stream().on("error", (e) => {
				this.isDestroyed || _.error("[MicRecordingService] Error:", e);
			});
		}
		destroy() {
			this.isDestroyed = !0;
			try {
				this.recording.stop();
			} catch (e) {
				_.error("[MicRecordingService] Error stopping:", e);
			}
		}
	}
	class d {
		audiotee;
		isDestroyed = !1;
		constructor() {
			this.audiotee = new Qv({
				sampleRate: s,
				chunkDurationMs: 50,
				binaryPath: e.join(Jv, "audiotee-0.0.7", "audiotee")
			}), this.audiotee.on("data", ({ data: e }) => {
				this.isDestroyed || Z.broadcastIpc("chat-audio-data", {
					role: "them",
					chunk: e
				});
			}), this.audiotee.on("error", (e) => {
				_.error("[SystemRecordingService] Error:", e);
			}), this.audiotee.start().catch((e) => {
				_.error("[SystemRecordingService] Error starting:", e);
			});
		}
		destroy() {
			this.isDestroyed = !0, this.audiotee.stop().catch((e) => {
				_.error("[SystemRecordingService] Error stopping:", e);
			});
		}
	}
})(ty ||= {});
//#endregion
