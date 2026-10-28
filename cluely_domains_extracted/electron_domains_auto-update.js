//#region electron/domains/auto-update.ts
var oy;
(function(e) {
	let n = o();
	function r() {
		me || (n.logger = _, n.setFeedURL(`https://${j.VITE_DESKTOP_RELEASES_DOMAIN}`), n.on("update-available", (e) => {
			Q.patchSharedState({ autoUpdate: {
				status: "update-available",
				version: e.version
			} });
		}), n.on("update-downloaded", (e) => {
			Q.patchSharedState({ autoUpdate: {
				status: "update-downloaded",
				version: e.version
			} });
		}), n.on("error", () => {
			Q.patchSharedState({ autoUpdate: { status: "idle" } });
		}), i(), setInterval(() => {
			i();
		}, 36e5));
	}
	e.init = r;
	async function i() {
		return me ? !1 : (await n.checkForUpdates())?.isUpdateAvailable ?? !1;
	}
	e.checkForUpdates = i;
	function a() {
		for (let e of t.getAllWindows()) e.destroy();
		n.quitAndInstall();
	}
	e.restartToUpdate = a;
	function o() {
		let { autoUpdater: e } = v;
		return e;
	}
})(oy ||= {});
//#endregion
