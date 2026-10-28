//#region electron/domains/state.ts
var Q;
(function(t) {
	let n = "shared-state.json", r = {
		appVersion: i.getVersion(),
		systemInfo: {
			platform: process.platform,
			arch: process.arch,
			osRelease: T.release(),
			cpus: T.cpus().map((e) => e.model),
			cpuCount: T.cpus().length
		},
		autoUpdate: { status: "idle" },
		openAtLogin: !1,
		signInStatus: "loading",
		isControlWindowLoaded: !1,
		isChatWindowLoaded: !1,
		isDashboardWindowLoaded: !1,
		isRecordingShortcut: !1,
		isChatRunning: !1,
		showChat: !0,
		showDashboard: !0,
		chatWindowIsExpanded: !1,
		isChatMoreMenuOpen: !1,
		isChatModesMenuOpen: !1,
		authRefreshCount: 0,
		dashboardFocusCount: 0,
		dashboardErrorMessage: null,
		session: null,
		meHasVoiceActivity: !1,
		themHasVoiceActivity: !1,
		lastSessionId: null,
		showSessionInactivityModal: !1,
		meetingNotification: null,
		handledMeetingNotificationIds: [],
		isCapturingScreenshot: !1
	}, a = {
		...Tm,
		...r
	}, o = a, s = !1, c = null, l = !1;
	async function u() {
		if (await ee(), await v(), !o.didMigrateV1State) {
			let e = ay.OldState.read();
			p({
				didMigrateV1State: !0,
				...e
			}), console.log("Migrated V1 state:", JSON.stringify(e, null, 2));
		}
	}
	t.init = u;
	function d() {
		l = !0;
	}
	t.onFinishInit = d;
	function f() {
		return o;
	}
	t.getSharedState = f;
	function p(e) {
		Object.keys(e).length !== 0 && h({
			...o,
			...e
		});
	}
	t.patchSharedState = p;
	function m() {
		h({
			...Tm,
			...r
		});
	}
	t.resetAllState = m;
	function h(e) {
		let t = g(e);
		ye(o, t) || (o = t, b(), l && (Yv.update(o), Xv.update(o), iy.update(o), ny.update(o), Z.update(o), ry.update(o), ty.update(o), Z.broadcastIpc("shared-state-updated", o)));
	}
	function g(e) {
		let t = { ...e };
		return Z.getPhase(t) !== "app" && (t.isControlWindowLoaded = !1, t.isChatWindowLoaded = !1, t.isDashboardWindowLoaded = !1, t.isRecordingShortcut = !1, t.isChatRunning = !1, t.showChat = !0, t.showDashboard = !0, t.chatWindowIsExpanded = !1, t.isChatMoreMenuOpen = !1, t.isChatModesMenuOpen = !1, t.dashboardErrorMessage = null, t.session = null, t.lastSessionId = null, t.meetingNotification = null, t.handledMeetingNotificationIds = [], t.isCapturingScreenshot = !1), t.session ? t.meetingNotification = null : (t.meHasVoiceActivity = !1, t.themHasVoiceActivity = !1, t.showSessionInactivityModal = !1), t.showChat || (t.isChatMoreMenuOpen = !1, t.isChatModesMenuOpen = !1), t;
	}
	async function v() {
		let e = E();
		if (!y(e)) {
			o = a, await b();
			return;
		}
		let t;
		try {
			t = await S(e, "utf8");
		} catch (e) {
			_.error("Failed to read shared state from disk. Resetting.", e), o = a, await b();
			return;
		}
		let n;
		try {
			n = JSON.parse(t);
		} catch (e) {
			_.error("Failed to parse shared state JSON. Resetting.", e), o = a, await b();
			return;
		}
		let i = wm.safeParse(n);
		if (!i.success) {
			_.error("Shared state failed schema validation. Resetting.", i.error), o = a, await b();
			return;
		}
		o = {
			...i.data,
			...r
		};
	}
	function b() {
		return s = !0, c || (c = (async () => {
			let e = E(), t = `${e}.tmp`;
			try {
				for (; s;) {
					s = !1;
					let n = wm.parse(o);
					await w(t, `${JSON.stringify(n, null, 2)}\n`, "utf8"), await C(t, e);
				}
			} catch (e) {
				_.error("Failed to save shared state to disk.", e);
			} finally {
				c = null;
			}
		})(), c);
	}
	function E() {
		return e.join(i.getPath("userData"), n);
	}
	async function ee() {
		if (process.platform !== "darwin") return;
		let t = e.join(i.getPath("userData"), "..", "cluely-v2", n), r = E();
		if (y(t) && !y(r)) try {
			await x(t, r), _.info("Copied shared state to temp app data dir");
		} catch (e) {
			_.error("Failed to copy shared state to temp app data dir", e);
		}
	}
})(Q ||= {});
//#endregion
