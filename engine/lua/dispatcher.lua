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
-- Commands: ping, loadBuild, stats, strip, tradeQuery, score, baseTypes, slotData, shutdown (see each handler below).
--
-- A new command touches five places:
--   1. its handler here (commands.<name>), and its row in engine/README.md's command table
--   2. CommandName in packages/engine-client/src/protocol.ts
--   3. DEFAULT_IDLE_MS in packages/engine-client/src/client.ts (how long it may go quiet)
--   4. a read<Name> in protocol.ts that checks its data (and its stream events, if it sends any)
--   5. a method on EngineClient (client.ts) that sends it, through serial() and sendForBuild() if it needs a build
--
-- Changes to the loaded build that last one command (a target, a stand-in item, a calc hook) go through
-- target.with and lua/buildedit.lua, which undo them even on error.

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
local slotdata = engineRequire("slotdata")
local generator = engineRequire("generator")
local buildedit = engineRequire("buildedit")
local uniques = engineRequire("uniques")

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
	-- A failed undo may have left a stand-in item in the build: the client must load it again (#39).
	local tainted = buildedit.tainted()
	if tainted then
		fail("stale-build", "build " .. state.buildId .. " must be loaded again: " .. tainted)
	end
end

local SECOND_WEAPON_SET_MESSAGE = "The build is saved with weapon set 2 in use, and Weapon 1 and Weapon 2 can only be searched"
	.. " for weapon set 1 for now. Switch PoB to weapon set 1 and save the build."

local function requireSlot(req)
	local name = requireString(req, "slot")
	local slot = build.itemsTab.slots[name]
	if not slot or slot.nodeId then
		fail("bad-slot", "no item slot named " .. name)
	end
	-- PoB leaves out the weapon slots of the set that isn't in use (CalcSetup.lua's slot loop, the same test),
	-- so an item put there would change nothing and every gain and weight would read 0 (#110). Scoring
	-- against weapon set 2 is #35.
	if slot.weaponSet and slot.weaponSet ~= (build.itemsTab.activeItemSet.useSecondWeaponSet and 2 or 1) then
		fail("inactive-weapon-set", SECOND_WEAPON_SET_MESSAGE)
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

local pobMessage = buildedit.pobMessage

local function itemInfo(item)
	-- type: PoB's item type ("Boots", "One Handed Sword"), the key of the slot data (slotData).
	return { name = item.name, base = item.baseName, rarity = item.rarity, type = item.base and item.base.type or nil }
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

-- A damage target that reads 0 because PoB disabled its skill (the wrong weapon, no shield; #36): warns with
-- PoB's own reason and returns true, else false. Searching for the item that enables the skill is left to the
-- user for now (Jarraxas, 26 Nov): the search weights come from PoB's current setup, so the user equips any base
-- that enables the skill in PoB first. Weights of our own, for that and more, are later work.
local function warnDisabledTarget(ctx, resolved)
	local reason = target.disableReason(resolved)
	if not reason then
		return false
	end
	ctx.warn(
		"target-disabled",
		"The damage target reads 0: PoB has disabled "
			.. reason
			.. ". Searches are weighted from your current setup in PoB, so equip something that enables the skill there first"
			.. " (any base of the right type will do), or pick another skill under \"Measure damage on\"."
	)
	return true
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
	buildedit.clearTaint()
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
	if baseline.damage == 0 and not warnDisabledTarget(ctx, resolved) then
		ctx.warn("no-damage-target", "the saved damage target reads 0 (a non-damage main skill?); pick a skill")
	end
	if build.itemsTab.activeItemSet.useSecondWeaponSet then
		ctx.warn("second-weapon-set", SECOND_WEAPON_SET_MESSAGE)
	end
	-- The build counts as loaded only now: a save whose saved target fails above (bad-target) leaves no build,
	-- as the client expects after a failed load (issue #42).
	state.buildSeq = state.buildSeq + 1
	state.buildId = "b" .. state.buildSeq
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
function commands.stats(req, ctx)
	requireBuild(req)
	local resolved = target.resolve(req.target)
	local keys = extraKeys(req)
	local block = target.with(resolved, function(useFullDps)
		return statblock.build(calculator()({}, useFullDps), resolved, keys, true)
	end)
	if block.damage == 0 then
		warnDisabledTarget(ctx, resolved)
	end
	return { target = target.describe(resolved), stats = block }
end

-- The totals the slot's item carries itself, from PoB's parsed mods (#34): what a strip need is capped at. The
-- site's pseudo totals count the same lines: "+#% to all Elemental Resistances" is PoB's ElementalResist (added
-- to each element here), "+# to all Attributes" and hybrid attribute mods already add to Str, Dex and Int.
-- nil for an empty slot.
local function itemTotals(slot)
	local item = build.itemsTab.items[slot.selItemId]
	-- Ring 2 and Weapon 2 read their own list, as PoB's CalcSetup does ("Left ring slot:" lines and the like).
	local list = item and (item.modList or (item.slotModList and item.slotModList[slot.slotNum or 1]))
	if not list then
		return nil
	end
	-- The item's list is a plain array of mods (ItemClass:BuildModListForSlotNum): sum it through a ModList.
	local mods = new("ModList"):ModList()
	mods:AddList(list)
	local function sum(name)
		return mods:Sum("BASE", nil, name)
	end
	local all = sum("ElementalResist")
	return {
		Chaos = sum("ChaosResist"),
		Fire = sum("FireResist") + all,
		Cold = sum("ColdResist") + all,
		Lightning = sum("LightningResist") + all,
		Str = sum("Str"),
		Dex = sum("Dex"),
		Int = sum("Int"),
	}
end

-- strip { buildId, slot, target?, extraKeys? } -> { target, slot, stats, itemTotals? } with the slot empty
function commands.strip(req)
	requireBuild(req)
	local slotName, slot = requireSlot(req)
	local resolved = target.resolve(req.target)
	local keys = extraKeys(req)
	local totals = itemTotals(slot)
	local block = target.with(resolved, function(useFullDps)
		return statblock.build(calculator()({ repSlotName = slotName, repItem = nil }, useFullDps), resolved, keys, false)
	end)
	return { target = target.describe(resolved), slot = slotName, stats = block, itemTotals = totals }
end

-- tradeQuery { buildId, slot, target?, dpsWeight?, ehpWeight?, options? } -> PoB's trade query generator output
-- (lua/generator.lua). Streams progress events ({ calcs, seconds }) every 25 calcs. Weights default to PoB's
-- (1.0 / 0.5). For a one-skill target the main skill is switched in memory and CombinedDPS is weighted
-- instead of FullDPS. options: the generator's StartQuery options (generator.DEFAULT_OPTIONS lists them and
-- their defaults).
function commands.tradeQuery(req, ctx)
	requireBuild(req)
	local slotName, slot = requireSlot(req)
	-- An empty slot is fine (issue #33): PoB's generator takes the category from the slot name and tests mods
	-- on a blank item, as its own GUI does. An empty weapon slot reads as a one-handed weapon; the search's
	-- category then comes from the slot plan's item type.
	local item = build.itemsTab.items[slot.selItemId]
	local dpsWeight = req.dpsWeight == nil and 1.0 or req.dpsWeight
	local ehpWeight = req.ehpWeight == nil and 0.5 or req.ehpWeight
	if type(dpsWeight) ~= "number" or type(ehpWeight) ~= "number" or dpsWeight < 0 or ehpWeight < 0 then
		fail("bad-request", "dpsWeight and ehpWeight must be non-negative numbers")
	end
	local options = generator.readOptions(req.options)
	local resolved = target.resolve(req.target)
	local statWeights = generator.statWeights(resolved, dpsWeight, ehpWeight)

	local run = generator.run(slot, resolved, statWeights, options, function(progress)
		ctx.event("progress", progress)
	end)

	local weights = json.array()
	for _, w in ipairs(run.generator.modWeights) do
		table.insert(weights, { id = w.tradeModId, weight = w.weight, meanStatDiff = w.meanStatDiff, invert = w.invert == true })
	end
	local result = run.result
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
	local calcContext = run.generator.calcContext
	return {
		slot = slotName,
		target = target.describe(resolved),
		item = item and itemInfo(item) or { name = "", base = "", rarity = "NONE" },
		category = { query = calcContext.itemCategoryQueryStr, generator = calcContext.itemCategory },
		statWeights = { { stat = statWeights[1].stat, weight = dpsWeight }, { stat = "TotalEHP", weight = ehpWeight } },
		affixQuality = main.defaultItemAffixQuality,
		baseStatValue = calcContext.baseStatValue,
		weights = weights,
		query = query,
		queryError = result.err,
		calcs = run.calcs,
		seconds = run.seconds,
		log = run.log,
	}
end

-- Every unique PoB knows for an item type, scored in the slot and weighted by its own rolls (#113, lua/uniques.lua).
function commands.uniques(req)
	requireBuild(req)
	local slotName = requireSlot(req)
	local itemType = requireString(req, "itemType")
	local dpsWeight = req.dpsWeight == nil and 1.0 or req.dpsWeight
	local ehpWeight = req.ehpWeight == nil and 0.5 or req.ehpWeight
	if type(dpsWeight) ~= "number" or type(ehpWeight) ~= "number" or dpsWeight < 0 or ehpWeight < 0 then
		fail("bad-request", "dpsWeight and ehpWeight must be non-negative numbers")
	end
	local resolved = target.resolve(req.target)
	local list = uniques.list(slotName, itemType, resolved, generator.statWeights(resolved, dpsWeight, ehpWeight))
	return { slot = slotName, itemType = itemType, target = target.describe(resolved), uniques = list }
end

-- Whether an item of weapon type w2Type can be held beside a Weapon 1 of type w1Type: PoB's rule for Weapon 2
-- (ItemsTab:IsItemValidForSlot, ItemsTab.lua:2681-2690), which is the game's (G6). w2Type is the Weapon 2
-- item's type ("Shield", "Quiver", "Wand").
local function fitsBeside(w1Type, w2Type)
	if w1Type == "Bow" then
		return w2Type == "Quiver"
	end
	local info = data.weaponTypeInfo
	if not (info[w1Type] and info[w1Type].oneHand) then
		return false
	end
	if w2Type == "Shield" then
		return true
	end
	return info[w2Type] ~= nil and info[w2Type].oneHand and (w1Type == "Wand") == (w2Type == "Wand")
end

-- The saved Weapon 2 item when scoring into Weapon 1, else nil.
local function savedOffHand(slotName)
	if slotName ~= "Weapon 1" then
		return nil
	end
	local slot = build.itemsTab.slots["Weapon 2"]
	return slot and build.itemsTab.items[slot.selItemId] or nil
end

-- score { buildId, slot, items: [text], target?, extraKeys? }
-- Streams one item event per item, in order: { index (0-based), ok, item, stats, unparsed, validForSlot,
-- offHandRemoved } or { index, ok = false, error }. Each item is swapped in for one compare calc; the build is
-- untouched afterwards. A full GC runs every gcEvery scores, between items. Final data: { count, failed,
-- gcRuns, seconds, offHandRemoved }.
--
-- Weapon hands (#39, #101): a Weapon 1 weapon that can't be held beside the saved Weapon 2 (a two-hander, a
-- bow without a quiver, a wand beside a sword) is scored with Weapon 2 emptied, as the game would take the
-- off-hand off; its result says offHandRemoved. PoB's compare calc does that by itself only for a staff and
-- the two-handed sword, axe and mace; a bow keeps the off-hand (PoB bug, pob-internals.md P12), and so do the
-- other pairs. The engine empties Weapon 2 for all of them alike, once for the batch (one rebuild each way):
-- the items that keep the off-hand are scored first, then the others inside buildedit.withSlotItem. Events
-- still go out in order: each result is sent once every earlier one is.
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
	local offHand = savedOffHand(slotName)

	local parsed, parseErrors, withoutOffHand = {}, {}, {}
	local removedCount = 0
	for i, text in ipairs(req.items) do
		if type(text) ~= "string" then
			parseErrors[i] = "item text must be a string"
		else
			parsed[i], parseErrors[i] = parseItem(text)
		end
		local item = parsed[i]
		if offHand and item and item.base.weapon and not fitsBeside(item.base.type, offHand.type) then
			withoutOffHand[i] = true
			removedCount = removedCount + 1
		end
	end

	local results, nextToSend = {}, 1
	local function flush()
		while results[nextToSend] do
			ctx.event("item", results[nextToSend])
			nextToSend = nextToSend + 1
		end
	end

	local function scoreOne(i, calcFunc, useFullDps)
		local result = { index = i - 1 }
		local item = parsed[i]
		if not item then
			result.ok = false
			result.error = { code = "parse-failed", message = parseErrors[i] }
			failed = failed + 1
			return result
		end
		local ok, out = pcall(calcFunc, { repSlotName = slotName, repItem = item }, useFullDps)
		if ok then
			result.ok = true
			result.item = itemInfo(item)
			result.unparsed = unparsedLines(item)
			result.validForSlot = build.itemsTab:IsItemValidForSlot(item, slotName) and true or false
			result.offHandRemoved = withoutOffHand[i] == true
			result.stats = statblock.build(out, resolved, keys, false)
		else
			result.ok = false
			result.error = { code = "calc-failed", message = tostring(out) }
			failed = failed + 1
		end
		state.scoresSinceGc = state.scoresSinceGc + 1
		return result
	end

	-- Scores the items whose withoutOffHand flag is `removed`, in order.
	local function scoreGroup(removed)
		target.with(resolved, function(useFullDps)
			local calcFunc = calculator()
			for i = 1, #req.items do
				if (withoutOffHand[i] == true) == removed then
					flush()
					results[i] = scoreOne(i, calcFunc, useFullDps)
					flush()
					if gcEvery > 0 and state.scoresSinceGc >= gcEvery then
						collectgarbage("collect")
						state.scoresSinceGc = 0
						state.gcRuns = state.gcRuns + 1
					end
				end
			end
		end)
	end

	scoreGroup(false)
	if removedCount > 0 then
		buildedit.withSlotItem("Weapon 2", nil, function()
			scoreGroup(true)
		end)
	end
	flush()
	return { count = #req.items, failed = failed, gcRuns = state.gcRuns, seconds = os.clock() - started, offHandRemoved = removedCount }
end

-- baseTypes {} -> { types: [{ baseType, bases }] }: every item type with bases, for picking a base type.
function commands.baseTypes()
	return { types = slotdata.baseTypes() }
end

-- slotData { baseType } -> what can roll on each base of that type (lua/slotdata.lua). Needs no build.
function commands.slotData(req)
	local baseType = requireString(req, "baseType")
	local result = slotdata.build(baseType)
	if not result then
		fail("bad-request", "no base type named " .. baseType)
	end
	result.pobVersion = pobVersion
	return result
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
