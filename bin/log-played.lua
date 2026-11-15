-- Append "time<TAB>file" to played.log whenever a new video starts.
local log = mp.command_native({"expand-path", "~/Videos/aerial/.meta/played.log"})
mp.register_event("file-loaded", function()
    local f = io.open(log, "a")
    if f then
        f:write(os.date("%Y-%m-%d %H:%M:%S"), "\t", mp.get_property("path", "?"), "\n")
        f:close()
    end
end)
