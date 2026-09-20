local wezterm = require("wezterm")
local config = wezterm.config_builder()

config.keys = {
	-- Alt+V 经终端发送；Alt+Shift+V 自动选择本地直读或 SSH 传输。
	{
		key = "v",
		mods = "ALT",
		action = wezterm.action_callback(function(_, pane)
			pane:send_text("\x1b[994~")
			wezterm.background_child_process({ "clipimg.exe", tostring(pane:pane_id()) })
		end),
	},
	{
		key = "v",
		mods = "ALT|SHIFT",
		action = wezterm.action.SendString("\x1b[991~"),
	},
}
