//#region electron/domains/lifecycle.ts
var ey;
(function(e) {
	let t = !1, n = !1;
	function r() {
		i.on("before-quit", () => {
			t = !0;
		});
	}
	e.init = r;
	function a() {
		t || n || (n = !0, o.showMessageBox({
			type: "error",
			title: "Something went wrong",
			message: "Cluely ran into a problem and needs to restart.",
			detail: "If this keeps happening, please contact support.",
			buttons: ["Quit", "Restart"],
			defaultId: 1,
			cancelId: 0,
			noLink: !0
		}).then((e) => {
			if (e.response === 1) {
				i.relaunch(), i.exit(0);
				return;
			}
			i.quit();
		}));
	}
	e.requireErrorRestart = a;
})(ey ||= {});
//#endregion
