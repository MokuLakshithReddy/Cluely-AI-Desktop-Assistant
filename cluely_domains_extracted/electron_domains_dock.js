//#region electron/domains/dock.ts
var Yv;
(function(e) {
	let n = null;
	function r() {
		a(Q.getSharedState());
	}
	e.init = r;
	function a(e) {
		let t = o(e);
		n !== t && (n = t, s(t));
	}
	e.update = a;
	function o(e) {
		return Z.areAppWindowsLoaded(e) ? !e.isInvisible : !0;
	}
	let s = ve({
		delay: 1e3,
		leading: !0
	}, (e) => {
		if (!(process.platform !== "darwin" || !i.dock)) if (e) i.dock.show();
		else {
			let e = t.getFocusedWindow(), n = Z.Dashboard.getWindow(), r = e != null && n != null && e === n;
			i.dock.hide(), r && c(n);
		}
	});
	function c(e) {
		setTimeout(() => {
			e.isDestroyed() || e.focus();
		}, 0);
	}
})(Yv ||= {});
//#endregion
