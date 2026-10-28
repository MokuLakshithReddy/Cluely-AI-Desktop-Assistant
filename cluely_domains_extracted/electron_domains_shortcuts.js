//#region electron/domains/shortcuts.ts
var ry;
(function(e) {
	let t = {
		toggleVisibility: null,
		ask: null,
		clear: null,
		toggleSession: null,
		moveUp: null,
		moveDown: null,
		moveLeft: null,
		moveRight: null,
		scrollUp: null,
		scrollDown: null
	}, n = {
		toggleVisibility: () => {
			let e = Q.getSharedState(), t = !e.showChat;
			Q.patchSharedState({ showChat: t }), t && !e.isInvisible && Z.broadcastIpc("chat-focus-input"), t || Z.broadcastIpc("chat-blur-input");
		},
		ask: () => {
			Z.broadcastIpc("chat-submit");
		},
		clear: () => {
			Z.Chat.clearInputAndCollapse();
		},
		toggleSession: () => {
			Q.getSharedState().session ? Z.broadcastIpc("control-end-session") : Z.broadcastIpc("control-start-session");
		},
		moveUp: () => {
			Z.Control.moveBy({ deltaY: -80 });
		},
		moveDown: () => {
			Z.Control.moveBy({ deltaY: 80 });
		},
		moveLeft: () => {
			Z.Control.moveBy({ deltaX: -80 });
		},
		moveRight: () => {
			Z.Control.moveBy({ deltaX: 80 });
		},
		scrollUp: () => {
			Z.broadcastIpc("chat-scroll", { deltaY: -240 });
		},
		scrollDown: () => {
			Z.broadcastIpc("chat-scroll", { deltaY: 240 });
		}
	};
	function r() {
		i(Q.getSharedState());
	}
	e.init = r;
	function i(e) {
		let t = a(e);
		for (let n of Object.keys(e.shortcuts)) o({
			key: n,
			accelerator: e.shortcuts[n],
			shouldRegister: t[n]
		});
	}
	e.update = i;
	function a(e) {
		if (e.isRecordingShortcut) return {
			toggleVisibility: !1,
			ask: !1,
			clear: !1,
			toggleSession: !1,
			moveUp: !1,
			moveDown: !1,
			moveLeft: !1,
			moveRight: !1,
			scrollUp: !1,
			scrollDown: !1
		};
		let t = Z.areAppWindowsLoaded(e), n = t && (!!e.session || e.isAmbientEnabled), r = n && e.showChat;
		return {
			toggleVisibility: n,
			ask: r,
			clear: r,
			toggleSession: t,
			moveUp: n,
			moveDown: n,
			moveLeft: n,
			moveRight: n,
			scrollUp: r,
			scrollDown: r
		};
	}
	function o({ key: e, accelerator: r, shouldRegister: i }) {
		let a = t[e];
		if (a && a !== r && (s.unregister(a), t[e] = null, a = null), !i) {
			a && s.unregister(a), t[e] = null;
			return;
		}
		t[e] !== r && (s.register(r, n[e]) || _.error(`Failed to register global shortcut: ${r}`), t[e] = r);
	}
})(ry ||= {});
//#endregion
