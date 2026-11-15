-- Wallpaper instances (AERIAL_INSTANCE set): write "time<TAB>file" to
-- $XDG_RUNTIME_DIR/aerial-wallpaper/now-<instance> whenever a new video starts, for that monitor's Conky panel.
local instance = os.getenv("AERIAL_INSTANCE")
local runtime = os.getenv("XDG_RUNTIME_DIR")
if not instance or not runtime then return end
local path = runtime .. "/aerial-wallpaper/now-" .. instance
mp.register_event("file-loaded", function()
    local f = io.open(path, "w")
    if f then
        f:write(os.date("%Y-%m-%d %H:%M:%S"), "\t", mp.get_property("path", "?"), "\n")
        f:close()
    end
end)
