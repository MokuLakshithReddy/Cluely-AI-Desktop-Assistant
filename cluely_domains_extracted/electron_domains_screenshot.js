//#region electron/domains/screenshot.ts
var fy;
(function(e) {
	let t = 1920, n = null;
	async function r() {
		let e = n;
		if (e) return await e;
		let t = (async () => {
			try {
				return Q.patchSharedState({ isCapturingScreenshot: !0 }), await he({
					times: 3,
					delay: 500
				}, i);
			} finally {
				Q.patchSharedState({ isCapturingScreenshot: !1 }), n = null;
			}
		})();
		return n = t, await t;
	}
	e.capture = r;
	async function i() {
		let e = Z.Chat.getWindow(), t = e ? p.getDisplayMatching(e.getBounds()) : p.getPrimaryDisplay(), n = await a.getSources({
			types: ["screen"],
			thumbnailSize: o(t.bounds)
		}), r = n.find((e) => e.display_id === t.id.toString()) ?? n[0];
		if (!r) throw Error(`Unable to capture screenshot: no display source found for display ${t.id}`);
		if (r.thumbnail.isEmpty()) throw Error("Unable to capture screenshot: thumbnail is empty");
		return {
			data: r.thumbnail.toPNG(),
			contentType: "image/png"
		};
	}
	function o(e) {
		let n = Math.max(e.width, e.height);
		if (n <= t) return {
			width: e.width,
			height: e.height
		};
		let r = t / n;
		return {
			width: Math.round(e.width * r),
			height: Math.round(e.height * r)
		};
	}
})(fy ||= {});
//#endregion
