//#region electron/domains/login.ts
var Xv;
(function(e) {
	let t = !1;
	function n() {
		if (!Q.getSharedState().didSetOpenAtLogin) {
			i.setLoginItemSettings({ openAtLogin: !0 }), t = !0, Q.patchSharedState({
				didSetOpenAtLogin: !0,
				openAtLogin: !0
			});
			return;
		}
		let { openAtLogin: e } = i.getLoginItemSettings();
		t = e, Q.patchSharedState({ openAtLogin: e });
	}
	e.init = n;
	function r(e) {
		t !== e.openAtLogin && (i.setLoginItemSettings({ openAtLogin: e.openAtLogin }), t = e.openAtLogin);
	}
	e.update = r;
})(Xv ||= {});
//#endregion
//#region ../../node_modules/.pnpm/audiotee@0.0.7/node_modules/audiotee/dist/index.js
var Zv = ne.dirname(ie(import.meta.url)), Qv = class {
	events = new te();
	process = null;
	isRunning = !1;
	options;
	constructor(e = {}) {
		this.options = e;
	}
	on(e, t) {
		return this.events.on(e, t), this;
	}
	once(e, t) {
		return this.events.once(e, t), this;
	}
	off(e, t) {
		return this.events.off(e, t), this;
	}
	removeAllListeners(e) {
		return this.events.removeAllListeners(e), this;
	}
	emit(e, ...t) {
		return this.events.emit(e, ...t);
	}
	buildArguments() {
		let e = [];
		return this.options.sampleRate !== void 0 && e.push("--sample-rate", this.options.sampleRate.toString()), this.options.chunkDurationMs !== void 0 && e.push("--chunk-duration", (this.options.chunkDurationMs / 1e3).toString()), this.options.mute && e.push("--mute"), this.options.includeProcesses && this.options.includeProcesses.length > 0 && e.push("--include-processes", ...this.options.includeProcesses.map((e) => e.toString())), this.options.excludeProcesses && this.options.excludeProcesses.length > 0 && e.push("--exclude-processes", ...this.options.excludeProcesses.map((e) => e.toString())), e;
	}
	handleStderr(e) {
		let t = e.toString("utf8").split("\n").filter((e) => e.trim());
		for (let e of t) try {
			let t = JSON.parse(e);
			(t.message_type === "debug" || t.message_type === "info") && this.emit("log", t.message_type, t.data), t.message_type === "stream_start" ? this.emit("start") : t.message_type === "stream_stop" ? this.emit("stop") : t.message_type === "error" && this.emit("error", Error(t.data.message));
		} catch (e) {
			console.error("Error parsing log message:", e);
		}
	}
	start() {
		return new Promise((e, t) => {
			if (this.isRunning) {
				t(/* @__PURE__ */ Error("AudioTee is already running"));
				return;
			}
			if (process.platform !== "darwin") {
				t(/* @__PURE__ */ Error(`AudioTee currently only supports macOS (darwin). Current platform: ${process.platform}`));
				return;
			}
			this.process = D(this.options.binaryPath ?? re(Zv, "..", "bin", "audiotee"), this.buildArguments()), this.process.on("error", (e) => {
				this.isRunning = !1, this.emit("error", e), t(e);
			}), this.process.on("exit", (e, t) => {
				if (this.isRunning = !1, e !== 0 && e !== null) {
					let t = /* @__PURE__ */ Error(`AudioTee process exited with code ${e}`);
					this.emit("error", t);
				}
			}), this.process.stdout?.on("data", (e) => {
				this.emit("data", { data: e });
			}), this.process.stderr?.on("data", (e) => {
				this.handleStderr(e);
			}), this.isRunning = !0, e();
		});
	}
	stop() {
		return new Promise((e) => {
			if (!this.isRunning || !this.process) {
				e();
				return;
			}
			let t = setTimeout(() => {
				this.process && this.isRunning && this.process.kill("SIGKILL");
			}, 5e3);
			this.process.once("exit", () => {
				clearTimeout(t), this.isRunning = !1, this.process = null, e();
			}), this.process.kill("SIGTERM");
		});
	}
	isActive() {
		return this.isRunning;
	}
};
//#endregion
//#region ../../node_modules/.pnpm/path-key@4.0.0/node_modules/path-key/index.js
function $v(e = {}) {
	let { env: t = process.env, platform: n = process.platform } = e;
	return n === "win32" ? Object.keys(t).reverse().find((e) => e.toUpperCase() === "PATH") || "Path" : "PATH";
}
//#endregion
