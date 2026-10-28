//#region electron/constants.ts
var Wv = e.dirname(E(import.meta.url));
new URL(j.VITE_RENDERER_URL);
var Gv = e.join(Wv, "..", "dist"), Kv = e.join(Wv, "preload.mjs"), qv = me ? e.join(Wv, "..", "..", "public") : e.join(Wv, "..", "dist"), Jv = me ? e.join(Wv, "..", "..", "extra-resources") : e.join(process.resourcesPath, "extra-resources"), Z;
(function(n) {
	let r = null;
	function a() {
		ae(), le(), i.on("activate", () => {
			Q.patchSharedState({ showDashboard: !0 });
		}), i.on("second-instance", () => {
			Q.patchSharedState({
				showDashboard: !0,
				dashboardFocusCount: Q.getSharedState().dashboardFocusCount + 1
			}), i.focus();
		}), i.on("before-quit", () => {
			for (let e of t.getAllWindows()) e.destroy();
		}), i.on("window-all-closed", () => {}), p.on("display-added", S), p.on("display-removed", S), p.on("display-metrics-changed", S), u.on("updated", () => {
			o(Q.getSharedState());
		}), ne.init(), o(Q.getSharedState());
	}
	n.init = a;
	function o(e) {
		u.themeSource = e.theme, D.update(e), te.update(e), C.update(e), w.update(e), T.update(e), E.update(e), x();
	}
	n.update = o;
	let s = n.broadcastIpc = (e, ...t) => {
		for (let n of [
			C.getWindow(),
			w.getWindow(),
			T.getWindow(),
			E.getWindow(),
			D.getWindow(),
			te.getWindow(),
			ne.getWindow()
		]) n?.webContents.send(e, ...t);
	};
	function c(e) {
		return e.permissions.microphone !== "granted" || e.permissions.screen !== "granted" || e.permissions.accessibility !== "granted" || !e.finishedOnboarding || e.signInStatus === "signed-out" ? "onboarding" : e.signInStatus === "loading" ? "splash" : "app";
	}
	n.getPhase = c;
	function l(e) {
		return e.isControlWindowLoaded && e.isChatWindowLoaded && e.isDashboardWindowLoaded;
	}
	n.areAppWindowsLoaded = l;
	let g = Hv({
		routeTree: Lv(),
		history: gh()
	});
	function v(e, t) {
		let n = g.buildLocation(t), r = new URL(`/#${n.href}`, re);
		e.loadURL(r.toString());
	}
	n.navigate = v;
	function b() {
		let e = C.getWindow();
		if (!e) return;
		let t = e.getBounds(), n = p.getDisplayMatching(t), r = n.bounds.y + n.bounds.height - t.height - 150;
		t.y > r && e.setPosition(t.x, r), x();
	}
	n.normalizeControlAndChatWindowPosition = b;
	function x(e = !1) {
		let t = C.getWindow(), n = w.getWindow();
		if (!t || !n) return;
		let r = t.getBounds(), i = n.getBounds(), a = {
			x: r.x + Math.round((r.width - i.width) / 2),
			y: r.y + r.height + 6,
			width: i.width,
			height: i.height
		}, o = p.getDisplayMatching(a);
		process.platform === "darwin" && a.y < o.workArea.y && (a.y = o.workArea.y), (i.x !== a.x || i.y !== a.y) && n.setPosition(a.x, a.y), process.platform !== "darwin" && e && (C.restoreSize(), w.restoreSize());
	}
	function S() {
		r && clearTimeout(r), r = setTimeout(() => {
			r = null, b();
		}, 50);
	}
	let C;
	(function(e) {
		let n = null;
		function r(e) {
			if (c(e) !== "app") {
				n?.destroy(), n = null;
				return;
			}
			n ||= f(e), n.setContentProtection(ue(e));
			let t = l(e) && (!!e.session || e.isAmbientEnabled) && (e.showChat || !e.hideChatHidesControlWindow);
			t !== n.isVisible() && (t ? k(n) : (n.hide(), e.hideChatHidesControlWindow && !e.showDashboard && process.platform === "darwin" && i.hide()));
			let r = g(e);
			r !== n.isFocusable() && (n.setFocusable(r), n.setSkipTaskbar(!0));
		}
		e.update = r;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o({ x: e, y: t }) {
			if (!n) return;
			let r = n.getBounds(), i = h({
				...r,
				x: e,
				y: t
			});
			i.x === r.x && i.y === r.y || (n.setPosition(i.x, i.y), x(!0));
		}
		e.setPosition = o;
		function s() {
			n && (n.setResizable(!0), n.setSize(163, 50), n.setResizable(!1));
		}
		e.restoreSize = s;
		function u({ deltaX: e = 0, deltaY: t = 0 }) {
			if (!n) return;
			let { x: r, y: i } = n.getBounds();
			o({
				x: r + e,
				y: i + t
			});
		}
		e.moveBy = u;
		function d() {
			if (!n) return;
			let { width: e } = n.getBounds(), { x: t, y: r } = m({
				targetDisplay: p.getDisplayMatching(n.getBounds()),
				width: e
			});
			o({
				x: t,
				y: r
			});
		}
		e.resetPosition = d;
		function f(e) {
			let { x: n, y: r } = m({
				targetDisplay: p.getPrimaryDisplay(),
				width: 163
			}), i = new t({
				...ie,
				alwaysOnTop: !0,
				closable: !1,
				focusable: g(e),
				frame: !1,
				fullscreenable: !1,
				hasShadow: !1,
				hiddenInMissionControl: !0,
				height: 50,
				minimizable: !1,
				resizable: !1,
				skipTaskbar: !0,
				show: !1,
				title: "Cluely",
				transparent: !0,
				type: "panel",
				width: 163,
				x: n,
				y: r
			});
			return O(i), v(i, { to: "/control" }), i;
		}
		function m({ targetDisplay: e, width: t }) {
			let n = e.bounds, r = e.workArea;
			return {
				x: n.x + Math.round((n.width - t) / 2),
				y: r.y + 25
			};
		}
		function h(e) {
			let t = (e, t, n) => Math.min(Math.max(e, t), n), n = p.getDisplayMatching(e), r = { ...e };
			return r.x = t(e.x, n.workArea.x, n.workArea.x + n.workArea.width - e.width), r.y = t(e.y, n.workArea.y, n.workArea.y + n.workArea.height - e.height), r;
		}
		function g(e) {
			return !(e.isInvisible && e.noFocusWhenInvisible);
		}
	})(C ||= n.Control ||= {});
	let w;
	(function(e) {
		let n = null, r = 500;
		function i(e) {
			if (c(e) !== "app") {
				n?.destroy(), n = null, r = 500;
				return;
			}
			n ||= p(e), n.setContentProtection(ue(e)), h(e);
			let t = l(e) && (!!e.session || e.isAmbientEnabled) && e.showChat;
			t !== n.isVisible() && (t ? k(n) : n.hide());
			let i = g(e);
			i !== n.isFocusable() && (n.setFocusable(i), n.setSkipTaskbar(!0));
		}
		e.update = i;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o() {
			n && (s("chat-clear-input"), Q.patchSharedState({ chatWindowIsExpanded: !1 }));
		}
		e.clearInputAndCollapse = o;
		function u(e) {
			if (!n) return;
			let t = Q.getSharedState();
			t.chatWindowIsExpanded && (r = Math.max(e, 350), h(t));
		}
		e.setHeight = u;
		function d() {
			r = 500, h(Q.getSharedState());
		}
		e.resetHeight = d;
		function f() {
			h(Q.getSharedState());
		}
		e.restoreSize = f;
		function p(e) {
			let n = new t({
				...ie,
				alwaysOnTop: !0,
				closable: !1,
				focusable: g(e),
				frame: !1,
				fullscreenable: !1,
				hasShadow: !1,
				height: m(e),
				hiddenInMissionControl: !0,
				maxWidth: 540,
				minWidth: 540,
				minimizable: !1,
				movable: !1,
				resizable: !1,
				skipTaskbar: !0,
				show: !1,
				title: "Cluely",
				transparent: !0,
				type: "panel",
				width: 540
			});
			return O(n), v(n, { to: "/chat" }), n;
		}
		function m(e) {
			let t = e.isInvisible ? 152 : 140;
			return e.chatWindowIsExpanded ? r : e.isChatMoreMenuOpen || e.isChatModesMenuOpen ? 500 : t;
		}
		function h(e) {
			n && (n.setResizable(!0), n.setMinimumSize(0, 0), n.setSize(540, m(e)), n.setResizable(!1));
		}
		function g(e) {
			return !(e.isInvisible && e.noFocusWhenInvisible);
		}
	})(w ||= n.Chat ||= {});
	let T;
	(function(e) {
		let n = null, r = 0;
		function i(e) {
			if (c(e) !== "app") {
				n?.destroy(), n = null, r = e.dashboardFocusCount;
				return;
			}
			n ||= o(), n.setBackgroundColor(s()), n.setContentProtection(ue(e)), process.platform !== "darwin" && n.setTitleBarOverlay(d());
			let t = l(e) && e.showDashboard;
			t !== n.isVisible() && (t ? n.show() : n.hide());
			let i = e.dashboardFocusCount !== r;
			t && i && n.focus(), r = e.dashboardFocusCount;
		}
		e.update = i;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o() {
			let e = process.platform === "darwin" ? {
				titleBarStyle: "hiddenInset",
				trafficLightPosition: {
					x: 12,
					y: 12
				}
			} : {
				titleBarOverlay: d(),
				titleBarStyle: "hidden"
			}, n = new t({
				...ie,
				backgroundColor: s(),
				...e,
				height: 700,
				minHeight: 600,
				minWidth: 800,
				show: !1,
				title: "Cluely",
				width: 1050
			});
			return n.on("close", (e) => {
				e.preventDefault(), Q.patchSharedState({ showDashboard: !1 });
			}), O(n), v(n, { to: "/dashboard" }), n;
		}
		function s() {
			return u.shouldUseDarkColors ? "#09090B" : "#FFFFFF";
		}
		function d() {
			return u.shouldUseDarkColors ? {
				color: "#00000000",
				height: 38,
				symbolColor: "#FFFFFF"
			} : {
				color: "#00000000",
				height: 38,
				symbolColor: "#000000"
			};
		}
	})(T ||= n.Dashboard ||= {});
	let E;
	(function(e) {
		let n = null;
		function r(e) {
			if (!(c(e) === "app" && e.meetingNotification !== null)) {
				n?.destroy(), n = null;
				return;
			}
			n ||= a(), n.setContentProtection(ue(e));
		}
		e.update = r;
		function i() {
			return n;
		}
		e.getWindow = i;
		function a() {
			let { workArea: e } = p.getPrimaryDisplay(), n = e.x + e.width - 360 - 15, r = e.y + 15, i = new t({
				...ie,
				alwaysOnTop: !0,
				backgroundColor: "#ffffff",
				closable: !1,
				frame: !1,
				height: 300,
				movable: !1,
				resizable: !1,
				skipTaskbar: !0,
				show: !1,
				title: "Upcoming Meeting",
				type: "panel",
				width: 360,
				x: n,
				y: r
			});
			return i.once("ready-to-show", () => {
				i.isDestroyed() || i.show();
			}), O(i), v(i, { to: "/notification" }), i;
		}
	})(E ||= n.MeetingNotification ||= {});
	let D;
	(function(e) {
		let n = null;
		function r(e) {
			if (c(e) !== "onboarding") {
				n?.destroy(), n = null;
				return;
			}
			n ||= o();
		}
		e.update = r;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o() {
			let e = process.platform === "darwin" ? {
				titleBarStyle: "hiddenInset",
				trafficLightPosition: {
					x: 12,
					y: 12
				}
			} : {
				titleBarOverlay: { color: "#00000000" },
				titleBarStyle: "hidden"
			}, n = new t({
				...ie,
				...e,
				height: 720,
				resizable: !1,
				show: !1,
				title: "Cluely",
				width: 1100
			});
			return n.once("ready-to-show", () => {
				n.isDestroyed() || n.show();
			}), n.on("close", () => {
				i.quit();
			}), O(n), v(n, { to: "/onboarding" }), n;
		}
	})(D ||= n.Onboarding ||= {});
	let te;
	(function(e) {
		let n = null;
		function r(e) {
			let t = c(e);
			if (!(t === "splash" || t === "app" && !l(e))) {
				n?.destroy(), n = null;
				return;
			}
			n ||= o();
		}
		e.update = r;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o() {
			let e = new t({
				...ie,
				alwaysOnTop: !0,
				backgroundColor: "#64647E",
				frame: !1,
				height: 400,
				resizable: !1,
				show: !1,
				title: "Cluely",
				width: 320
			});
			return e.once("ready-to-show", () => {
				e.isDestroyed() || e.show();
			}), e.on("close", () => {
				i.quit();
			}), O(e), v(e, { to: "/splash" }), e;
		}
	})(te ||= n.Splash ||= {});
	let ne;
	(function(e) {
		let n = null;
		function r() {
			n ||= o();
		}
		e.init = r;
		async function i() {
			if (!n) return null;
			try {
				let e = await n.webContents.executeJavaScript("window._globalGetToken ? window._globalGetToken() : null");
				return typeof e == "string" ? e : null;
			} catch (e) {
				return _.error("Error getting token from auth window:", e), null;
			}
		}
		e.getToken = i;
		function a() {
			return n;
		}
		e.getWindow = a;
		function o() {
			let e = new t({
				...ie,
				closable: !1,
				show: !1
			});
			return O(e), v(e, { to: "/auth" }), e;
		}
	})(ne ||= n.Auth ||= {});
	let re = new URL(j.VITE_RENDERER_URL), ie = {
		acceptFirstMouse: !0,
		webPreferences: { preload: Kv }
	};
	function O(e) {
		let t = re.origin;
		e.webContents.on("will-navigate", (e, n) => {
			new URL(n).origin !== t && (_.warn("Blocked window navigation:", n), e.preventDefault());
		}), e.webContents.on("will-redirect", (e, n) => {
			new URL(n).origin !== t && (_.warn("Blocked window redirect:", n), e.preventDefault());
		}), e.webContents.setWindowOpenHandler(({ url: e }) => {
			if (URL.canParse(e)) {
				let t = new URL(e).protocol;
				if (t === "https:" || t === "mailto:") return h.openExternal(e), { action: "deny" };
			}
			return _.warn("Blocked window open:", e), { action: "deny" };
		});
	}
	function ae() {
		f.handle("https", (e) => {
			let t = new URL(e.url);
			return !me && t.origin === re.origin ? oe(t) : t.origin === "https://cdn.jsdelivr.net" ? se(t) : d.fetch(e, { bypassCustomProtocolHandlers: !0 });
		});
	}
	function oe(t) {
		let n = ce(t, Gv);
		if (!n) return new Response("Not found", { status: 404 });
		if (e.extname(n) !== "") return y(n) ? d.fetch(ee(n).toString()) : new Response("Not found", { status: 404 });
		let r = e.join(Gv, "index.html");
		return d.fetch(ee(r).toString());
	}
	function se(t) {
		let n = ce(t, e.join(Jv, "vad"));
		return !n || !y(n) ? new Response("Not found", { status: 404 }) : d.fetch(ee(n).toString());
	}
	function ce(t, n) {
		let r = t.pathname || "/";
		if (!r.startsWith("/")) return null;
		let i = decodeURIComponent(r.slice(1));
		return i.includes("..") || e.isAbsolute(i) ? null : e.resolve(n, i);
	}
	function le() {
		m.defaultSession.webRequest.onBeforeSendHeaders((e, t) => {
			t({ requestHeaders: {
				...e.requestHeaders,
				Origin: re.origin
			} });
		});
	}
	function ue(e) {
		return e.isInvisible || e.isCapturingScreenshot;
	}
	let de = /* @__PURE__ */ new WeakMap();
	function k(e) {
		if (process.platform === "darwin") {
			e.show();
			return;
		}
		e.setOpacity(0), e.show(), clearTimeout(de.get(e));
		let t = setTimeout(() => {
			e.isDestroyed() || e.setOpacity(1);
		}, 30);
		de.set(e, t);
	}
})(Z ||= {});
//#endregion
