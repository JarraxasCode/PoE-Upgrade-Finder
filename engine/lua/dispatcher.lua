-- Engine dispatcher: headless PoB driven over stdio, one JSON message per line (PLAN.md, Engine).
--
-- Run from PoB's src folder (LUA_PATH must reach ../runtime/lua), via luahost:
--   luahost <runtime> <pob/src> engine/lua/dispatcher.lua [--gc-every=N]
--
-- Requests (stdin):  { "id": <number|string>, "cmd": "<command>", ...arguments }
-- Responses (stdout):
--   final   { "id", "ok": true,  "data": {...},                    "warnings": [...] }
--           { "id", "ok": false, "error": { "code", "message" },   "warnings": [...] }
--   stream  { "id", "event": "progress" | "item", "data": {...} }  (before the final message)
--   startup { "event": "ready", "data": { "pobVersion", "gcEvery" } }, or { "event": "fatal", "error": {...} }
-- Only protocol lines go to stdout; print, ConPrintf and io.write go to stderr. Non-finite numbers are
-- sent as "Infinity", "-Infinity" or "NaN". One build is loaded at a time; commands name it by buildId,
-- and a stale id is refused. Cancel is the client's job: it sends `score` in small batches and stops
-- sending, so a cancel takes effect between items.
--
-- Commands: ping, loadBuild, stats, strip, tradeQuery, score, shutdown (see each handler below).

ENGINE_DIR = (arg and arg[0] or ""):match("^(.*[/\\])") or "./"

-- Loads engine/lua/<name>.lua once and caches it, like require (which can't reach this folder: the
-- working directory is PoB's src). One instance per module matters: json.array's marker must be shared.
local engineModules = {}
function engineRequire(name)
	local module = engineModules[name]
	if module == nil then
		module = dofile(ENGINE_DIR .. name .. ".lua")
		engineModules[name] = module
	end
	return module
end

local engineArgs = {}
for i = 1, #(arg or {}) do
	engineArgs[i] = arg[i]
end

-- Keep stdout for the protocol only.
local stdout = io.stdout
local stderr = io.stderr
function print(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	stderr:write(table.concat(parts, "\t"), "\n")
end
io.output(stderr)

local json = engineRequire("json")
local itemview = engineRequire("itemview")

local function send(message)
	stdout:write(json.encode(message), "\n")
	stdout:flush()
end

local gcEvery = 100
for _, a in ipairs(engineArgs) do
	local n = a:match("^%-%-gc%-every=(%d+)$")
	if n then
		gcEvery = tonumber(n)
	end
end

-- Load PoB. On a startup error HeadlessWrapper prints the message and waits on io.read; don't let it
-- swallow a request line.
local realRead = io.read
io.read = function()
	return nil
end
local wrapperOk, wrapperErr = pcall(dofile, "HeadlessWrapper.lua")
io.read = realRead
if not wrapperOk or not build then
	send({ event = "fatal", error = { code = "pob-startup", message = tostring(wrapperOk and (__mainObject__ and __mainObject__.promptMsg) or wrapperErr) } })
	os.exit(3)
end
function ConPrintf(fmt, ...)
	stderr:write(string.format(fmt, ...), "\n")
end

local statblock = engineRequire("statblock")
local target = engineRequire("target")

local pobVersion = launch and launch.versionNumber or "?"

-- Engine state ----------------------------------------------------------------------------------------
local state = {
	buildSeq = 0,
	buildId = nil,
	scoresSinceGc = 0,
	gcRuns = 0,
}

local function fail(code, message)
	error({ code = code, message = message }, 0)
end

local function requireString(req, field)
	local v = req[field]
	if type(v) ~= "string" or v == "" then
		fail("bad-request", field .. " must be a non-empty string")
	end
	return v
end

local function requireBuild(req)
	if not state.buildId then
		fail("no-build", "no build is loaded")
	end
	if req.buildId ~= state.buildId then
		fail("stale-build", "build " .. tostring(req.buildId) .. " is not loaded (current: " .. state.buildId .. ")")
	end
end

local function requireSlot(req)
	local name = requireString(req, "slot")
	local slot = build.itemsTab.slots[name]
	if not slot or slot.nodeId then
		fail("bad-slot", "no item slot named " .. name)
	end
	return name, slot
end

local function extraKeys(req)
	local list = req.extraKeys
	if list == nil then
		return nil
	end
	if type(list) ~= "table" then
		fail("bad-request", "extraKeys must be an array of strings")
	end
	for _, k in ipairs(list) do
		if type(k) ~= "string" then
			fail("bad-request", "extraKeys must be an array of strings")
		end
	end
	return list
end

local function calculator()
	local calcFunc = build.calcsTab:GetMiscCalculator()
	if not calcFunc then
		fail("internal", "PoB has no calculator for this build")
	end
	return calcFunc
end

-- PoB's prompt text without colour codes (^1, ^x00FF00) or its "Press Enter/Escape..." key hints.
local function pobMessage(text)
	local lines = {}
	for line in (StripEscapes(tostring(text)) .. "\n"):gmatch("(.-)\r?\n") do
		if line ~= "" and not line:match("^Press ") then
			table.insert(lines, line)
		end
	end
	return table.concat(lines, "\n")
end

local function itemInfo(item)
	return { name = item.name, base = item.baseName, rarity = item.rarity }
end

-- Parses an item text the way PoB's own item import does (the kit's rule).
local function parseItem(text)
	local ok, item = pcall(function()
		local it = new("Item"):Item(text)
		it:NormaliseQuality()
		it:BuildModList()
		return it
	end)
	if not ok then
		return nil, tostring(item)
	end
	if not item.base then
		if item.baseName then
			return nil, "PoB doesn't know the base type " .. item.baseName
		end
		return nil, "PoB found no base type in the item text"
	end
	return item
end

-- Mod lines PoB couldn't parse (they have `extra` set).
local function unparsedLines(item)
	local lines = json.array()
	for _, list in ipairs({ item.enchantModLines, item.scourgeModLines, item.implicitModLines, item.explicitModLines, item.crucibleModLines }) do
		for _, ml in ipairs(list or {}) do
			if ml.extra then
				table.insert(lines, ml.line)
			end
		end
	end
	return lines
end

-- Commands --------------------------------------------------------------------------------------------
local commands = {}

-- ping {} -> { pobVersion, buildId, scoresSinceGc, gcRuns, luaHeapMb }
function commands.ping()
	return {
		pobVersion = pobVersion, buildId = state.buildId, gcEvery = gcEvery,
		scoresSinceGc = state.scoresSinceGc, gcRuns = state.gcRuns, luaHeapMb = collectgarbage("count") / 1024,
	}
end

-- loadBuild { xml, name? } -> { buildId, pobVersion, build info, skills, target, baseline, equipped }
-- The XML comes in the request, never as a path. A failed load returns PoB's own message (load-failed).
function commands.loadBuild(req, ctx)
	local xml = requireString(req, "xml")
	state.buildId = nil
	launch.promptMsg = nil
	local ok, err = pcall(loadBuildFromXML, xml, type(req.name) == "string" and req.name or "Build")
	if not ok then
		fail("load-failed", tostring(err))
	end
	if launch.promptMsg then
		local message = pobMessage(launch.promptMsg)
		launch.promptMsg = nil
		fail("load-failed", message)
	end
	if not (build.calcsTab and build.calcsTab.miscCalculator) then
		fail("load-failed", "PoB has no calculator after loading the build")
	end
	collectgarbage("collect")
	state.scoresSinceGc = 0
	state.buildSeq = state.buildSeq + 1
	state.buildId = "b" .. state.buildSeq

	local equipped = json.array()
	for _, slot in ipairs(build.itemsTab.orderedSlots) do
		local item = not slot.nodeId and slot.selItemId and build.itemsTab.items[slot.selItemId]
		if item then
			local info = itemInfo(item)
			info.slot = slot.slotName
			info.text = item.BuildRaw and item:BuildRaw() or item.raw
			local okView, view = pcall(itemview.build, item)
			if okView then
				info.view = view
			else
				ctx.warn("item-view", slot.slotName .. ": " .. tostring(view))
			end
			table.insert(equipped, info)
		end
	end

	local resolved = target.resolve(nil)
	local baseline = target.with(resolved, function(useFullDps)
		return statblock.build(calculator()({}, useFullDps), resolved, extraKeys(req), true)
	end)
	if baseline.damage == 0 then
		ctx.warn("no-damage-target", "the saved damage target reads 0 (a non-damage main skill?); pick a skill")
	end
	return {
		buildId = state.buildId,
		pobVersion = pobVersion,
		info = {
			className = build.spec and build.spec.curClassName or nil,
			ascendClassName = build.spec and build.spec.curAscendClassName or nil,
			level = build.characterLevel,
			treeVersion = build.spec and build.spec.treeVersion or nil,
			mainSocketGroup = build.mainSocketGroup,
		},
		skills = target.listSkills(),
		target = target.describe(resolved),
		baseline = baseline,
		equipped = equipped,
	}
end

-- stats { buildId, target?, extraKeys? } -> { target, stats }
function commands.stats(req)
	requireBuild(req)
	local resolved = target.resolve(req.target)
	local keys = extraKeys(req)
	local block = target.with(resolved, function(useFullDps)
		return statblock.build(calculator()({}, useFullDps), resolved, keys, true)
	end)
	return { target = target.describe(resolved), stats = block }
end

-- strip { buildId, slot, target?, extraKeys? } -> { target, slot, stats } with the slot empty
function commands.strip(req)
	requireBuild(req)
	local slotName = requireSlot(req)
	local resolved = target.resolve(req.target)
	local keys = extraKeys(req)
	local block = target.with(resolved, function(useFullDps)
		return statblock.build(calculator()({ repSlotName = slotName, repItem = nil }, useFullDps), resolved, keys, false)
	end)
	return { target = target.describe(resolved), slot = slotName, stats = block }
end

-- tradeQuery { buildId, slot, target?, dpsWeight?, ehpWeight? } -> PoB's trade query generator output.
-- Streams progress events ({ calcs }) every 25 calcs. Weights default to PoB's (1.0 / 0.5). For a
-- one-skill target the main skill is switched in memory and CombinedDPS is weighted instead of FullDPS.
function commands.tradeQuery(req, ctx)
	requireBuild(req)
	local slotName, slot = requireSlot(req)
	local item = build.itemsTab.items[slot.selItemId]
	if not item then
		fail("empty-slot", slotName .. " has no item; PoB's generator needs one to pick the item category")
	end
	local dpsWeight = req.dpsWeight == nil and 1.0 or req.dpsWeight
	local ehpWeight = req.ehpWeight == nil and 0.5 or req.ehpWeight
	if type(dpsWeight) ~= "number" or type(ehpWeight) ~= "number" or dpsWeight < 0 or ehpWeight < 0 then
		fail("bad-request", "dpsWeight and ehpWeight must be non-negative numbers")
	end
	local resolved = target.resolve(req.target)
	local damageStat = resolved.kind == "fullDps" and "FullDPS" or "CombinedDPS"
	local statWeights = {
		{ label = damageStat, stat = damageStat, weightMult = dpsWeight },
		{ label = "Effective Hit Pool", stat = "TotalEHP", weightMult = ehpWeight },
	}

	local log = json.array()
	local calcs = 0
	local realGetMisc = build.calcsTab.GetMiscCalculator
	local realConPrintf = ConPrintf
	local started = os.clock()

	local function run(useFullDps)
		local generator = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab })
		local result = nil
		generator.requesterCallback = function(_, queryTable, errMsg)
			result = { query = queryTable, err = errMsg }
		end
		generator.requesterContext = {}
		-- Counts calcs for progress. For a one-skill target it also turns the Full DPS roll-up off: PoB's
		-- generator calls the calculator with no flag, which means "on", but only FullDPS, FullDotDPS and
		-- SkillDPS come from the roll-up, and a one-skill target weights CombinedDPS and TotalEHP. Checked in one
		-- worker on RF, Animate - EarlyMid and Slamraxas: weights, query and baseStatValue are bit-identical
		-- either way, and Animate's Gloves take about 1 s instead of 30 s.
		build.calcsTab.GetMiscCalculator = function(tab)
			local func, base = realGetMisc(tab)
			return function(override, flag)
				calcs = calcs + 1
				if calcs % 25 == 0 then
					ctx.event("progress", { calcs = calcs, seconds = os.clock() - started })
				end
				if useFullDps then
					return func(override, flag)
				end
				return func(override, false)
			end, base
		end
		ConPrintf = function(fmt, ...)
			local line = string.format(fmt, ...)
			table.insert(log, line)
			stderr:write(line, "\n")
		end
		generator:StartQuery(slot, {
			statWeights = statWeights, includeCorrupted = false, includeScourge = false, includeTalisman = false,
			includeEldritch = "None", includeMirrored = false, maxLevel = nil,
		})
		-- As TradeQueryGenerator:OnFrame, but an error inside the coroutine is raised, not swallowed (V14).
		while generator.calcContext.co do
			local ok, errMsg = coroutine.resume(generator.calcContext.co, generator)
			if not ok then
				error("PoB's trade query generator failed: " .. tostring(errMsg), 0)
			end
			if coroutine.status(generator.calcContext.co) == "dead" then
				generator.calcContext.co = nil
				generator:FinishQuery()
			end
		end
		if not result then
			fail("generator-failed", "PoB's trade query generator returned nothing (" .. (log[#log] or "no log") .. ")")
		end
		return generator, result
	end

	local ok, generator, result = pcall(target.with, resolved, run)
	build.calcsTab.GetMiscCalculator = realGetMisc
	ConPrintf = realConPrintf
	if not ok then
		error(generator, 0)
	end

	local weights = json.array()
	for _, w in ipairs(generator.modWeights) do
		table.insert(weights, { id = w.tradeModId, weight = w.weight, meanStatDiff = w.meanStatDiff, invert = w.invert == true })
	end
	local query = result.query
	if type(query) == "table" and type(query.stats) == "table" then
		json.array(query.stats)
		for _, group in ipairs(query.stats) do
			if type(group.filters) == "table" then
				json.array(group.filters)
			end
		end
	end
	if result.err then
		ctx.warn("generator", tostring(result.err))
	end
	local calcContext = generator.calcContext
	return {
		slot = slotName,
		target = target.describe(resolved),
		item = itemInfo(item),
		category = { query = calcContext.itemCategoryQueryStr, generator = calcContext.itemCategory },
		statWeights = { { stat = damageStat, weight = dpsWeight }, { stat = "TotalEHP", weight = ehpWeight } },
		affixQuality = main.defaultItemAffixQuality,
		baseStatValue = calcContext.baseStatValue,
		weights = weights,
		query = query,
		queryError = result.err,
		calcs = calcs,
		seconds = os.clock() - started,
		log = log,
	}
end

-- score { buildId, slot, items: [text], target?, extraKeys? }
-- Streams one item event per item, in order: { index (0-based), ok, item, stats, unparsed } or
-- { index, ok = false, error }. Each item is swapped in for one compare calc; the build is untouched.
-- A full GC runs every gcEvery scores, between items. Final data: { count, failed, gcRuns, seconds }.
function commands.score(req, ctx)
	requireBuild(req)
	local slotName = requireSlot(req)
	if type(req.items) ~= "table" then
		fail("bad-request", "items must be an array of item texts")
	end
	local resolved = target.resolve(req.target)
	local keys = extraKeys(req)
	local started = os.clock()
	local failed = 0
	target.with(resolved, function(useFullDps)
		local calcFunc = calculator()
		for i, text in ipairs(req.items) do
			local result = { index = i - 1 }
			local item, err
			if type(text) ~= "string" then
				err = "item text must be a string"
			else
				item, err = parseItem(text)
			end
			if not item then
				result.ok = false
				result.error = { code = "parse-failed", message = err }
				failed = failed + 1
			else
				local ok, out = pcall(calcFunc, { repSlotName = slotName, repItem = item }, useFullDps)
				if ok then
					result.ok = true
					result.item = itemInfo(item)
					result.unparsed = unparsedLines(item)
					result.validForSlot = build.itemsTab:IsItemValidForSlot(item, slotName) and true or false
					result.stats = statblock.build(out, resolved, keys, false)
				else
					result.ok = false
					result.error = { code = "calc-failed", message = tostring(out) }
					failed = failed + 1
				end
				state.scoresSinceGc = state.scoresSinceGc + 1
			end
			ctx.event("item", result)
			if gcEvery > 0 and state.scoresSinceGc >= gcEvery then
				collectgarbage("collect")
				state.scoresSinceGc = 0
				state.gcRuns = state.gcRuns + 1
			end
		end
	end)
	return { count = #req.items, failed = failed, gcRuns = state.gcRuns, seconds = os.clock() - started }
end

-- shutdown {} -> {} and the engine exits.
local shuttingDown = false
function commands.shutdown()
	shuttingDown = true
	return {}
end

-- Main loop -------------------------------------------------------------------------------------------
local function toError(e)
	if type(e) == "table" and e.code then
		return e
	end
	return { code = "internal", message = debug.traceback(tostring(e), 2) }
end

local function handle(line)
	local req, decodeErr = json.decode(line)
	if type(req) ~= "table" then
		send({ ok = false, error = { code = "bad-request", message = "not a JSON object: " .. tostring(decodeErr) }, warnings = json.array() })
		return
	end
	local id = req.id
	if type(id) ~= "number" and type(id) ~= "string" then
		send({ ok = false, error = { code = "bad-request", message = "id must be a number or a string" }, warnings = json.array() })
		return
	end
	local handler = type(req.cmd) == "string" and commands[req.cmd]
	local warnings = json.array()
	local ctx = {
		warn = function(code, message)
			table.insert(warnings, { code = code, message = message })
		end,
		event = function(name, data)
			send({ id = id, event = name, data = data })
		end,
	}
	if not handler then
		send({ id = id, ok = false, error = { code = "unknown-command", message = "unknown command " .. tostring(req.cmd) }, warnings = warnings })
		return
	end
	local ok, data = xpcall(function()
		return handler(req, ctx)
	end, toError)
	if ok then
		send({ id = id, ok = true, data = data, warnings = warnings })
	else
		stderr:write("engine: ", tostring(req.cmd), " failed: ", tostring(data.message), "\n")
		send({ id = id, ok = false, error = { code = data.code, message = tostring(data.message) }, warnings = warnings })
	end
end

send({ event = "ready", data = { pobVersion = pobVersion, gcEvery = gcEvery } })
while not shuttingDown do
	local line = io.stdin:read("*l")
	if line == nil then
		break
	end
	line = line:gsub("\r$", "")
	if line ~= "" then
		handle(line)
	end
end
