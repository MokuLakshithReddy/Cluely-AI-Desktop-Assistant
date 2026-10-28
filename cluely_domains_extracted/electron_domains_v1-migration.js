//#region electron/domains/v1-migration.ts
var ay;
(function(t) {
	let n;
	(function(t) {
		let n = e.join(i.getPath("userData"), "..", "cluely"), r = {
			invisible: e.join(n, "undetectability.enabled"),
			keybindings: e.join(n, "keybindings"),
			theme: e.join(n, "theme"),
			useScreenEnabled: e.join(n, "use_screen.enabled")
		};
		function a() {
			if (!y(n)) return {};
			let e = c(r.keybindings, l);
			return {
				permissions: {
					microphone: "granted",
					screen: "granted",
					accessibility: "granted"
				},
				isInvisible: o(r.invisible),
				shortcuts: e ? {
					clear: e.start_over,
					ask: e.trigger_ai,
					toggleVisibility: e.hide,
					moveUp: e.move_window_up,
					moveDown: e.move_window_down,
					moveLeft: e.move_window_left,
					moveRight: e.move_window_right,
					scrollUp: e.scroll_response_up,
					scrollDown: e.scroll_response_down,
					toggleSession: e.toggle_session
				} : Cm,
				finishedOnboarding: !0,
				theme: c(r.theme, u) ?? "system",
				screenUse: s(r.useScreenEnabled) ? "required" : "off"
			};
		}
		t.read = a;
		function o(e) {
			try {
				return y(e);
			} catch {
				return !1;
			}
		}
		function s(e) {
			try {
				return y(e) ? b(e, "utf-8").trim() === "true" : !0;
			} catch {
				return !0;
			}
		}
		function c(e, t) {
			try {
				let n = b(e).toString(), r = JSON.parse(n);
				return t.parse(r);
			} catch {
				return null;
			}
		}
		let l = q.object({
			start_over: q.string(),
			trigger_ai: q.string(),
			hide: q.string(),
			move_window_up: q.string(),
			move_window_down: q.string(),
			move_window_left: q.string(),
			move_window_right: q.string(),
			scroll_response_up: q.string(),
			scroll_response_down: q.string(),
			toggle_session: q.string()
		}), u = q.enum([
			"system",
			"light",
			"dark"
		]);
	})(n ||= t.OldState ||= {});
})(ay ||= {});
//#endregion
