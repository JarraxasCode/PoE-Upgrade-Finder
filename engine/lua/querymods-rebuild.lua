-- Rebuilds PoB's Data/QueryMods.lua (the trade query generator's mod-to-trade-stat table) with this PoB's
-- own code, offline. PoB ships the file prebuilt and it lags its code: on 2.67.2 a rebuild added 97 explicit
-- and 29 corrupted families (V7, PLAN.md). The stats download in InitMods is answered with PoB's bundled
-- Data/TradeSiteStats.lua, so nothing is fetched and the result is the same for every user of a release.
--
-- Run from PoB's src folder:  luahost <runtime> <pob/src> querymods-rebuild.lua <outDir>
-- Writes <outDir>/QueryMods.lua (the caller moves it into Data/) and prints one JSON line:
--   {"ok":true,"seconds":…,"entries":{…},"unmatched":N}

local outDir = arg[1]
if not outDir then
	error("usage: querymods-rebuild.lua <outDir>")
end

dofile("HeadlessWrapper.lua")
local dkjson = require("dkjson")

local unmatched = 0
function ConPrintf(fmt, ...)
	local line = string.format(fmt, ...)
	if line:find("^Unable to match") then
		unmatched = unmatched + 1
	end
end

-- InitMods downloads /api/trade/data/stats through lcurl: answer with the bundled copy of that list.
local bundledStats = require("Data.TradeSiteStats")
local fakeCurl = {
	easy = function()
		local writer
		return {
			setopt_url = function() end,
			setopt_useragent = function() end,
			setopt_writefunction = function(_, fn)
				writer = fn
			end,
			perform = function()
				writer(dkjson.encode({ result = bundledStats }))
				return true
			end,
			close = function() end,
		}
	end,
}
local wrappedRequire = require
function require(name)
	if name == "lcurl.safe" then
		return fakeCurl
	end
	return wrappedRequire(name)
end

-- Hide the shipped QueryMods.lua (forces the rebuild). QueryMods.lua goes to outDir; the re-sorted
-- TradeSiteStats.lua InitMods also writes goes there too and is ignored, so PoB's own files stay untouched.
local realOpen = io.open
io.open = function(path, mode)
	local writing = mode ~= nil and mode:find("w") ~= nil
	if path:find("QueryMods%.lua$") and not writing then
		return nil, "hidden for the rebuild"
	end
	if writing and (path:find("QueryMods%.lua$") or path:find("TradeSiteStats%.lua$")) then
		return realOpen(outDir .. "/" .. path:match("([^/\\]+)$"), mode)
	end
	return realOpen(path, mode)
end

local t0 = os.clock()
local generator = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = {} })
local seconds = os.clock() - t0
io.open = realOpen
require = wrappedRequire

local entries = {}
for modType, list in pairs(generator.modData) do
	local n = 0
	for _ in pairs(list) do
		n = n + 1
	end
	entries[modType] = n
end
print(dkjson.encode({ ok = true, seconds = seconds, entries = entries, unmatched = unmatched }))
