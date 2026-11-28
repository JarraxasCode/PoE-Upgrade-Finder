-- PoB's trade query generator, run headless (issue #48; V14). The dispatcher's tradeQuery checks the request
-- and calls generator.run; v0.3's own generator reuses the same pieces (buildedit.withCalcHook, and
-- buildedit.withSlotItem for measuring from a stand-in item).

local json = engineRequire("json")
local target = engineRequire("target")
local buildedit = engineRequire("buildedit")

local generator = {}

local function fail(code, message)
	error({ code = code, message = message }, 0)
end

-- The StartQuery options a request may set, with the values used when it doesn't (as before #48, so the
-- generator's output is unchanged). includeEldritch takes the GUI's dropdown values; "None" (the default)
-- isn't one of them and acts like "Remove": only a value starting "Keep" adds eldritch mods.
generator.DEFAULT_OPTIONS = {
	includeCorrupted = false,
	includeScourge = false,
	includeTalisman = false,
	includeEldritch = "None",
	includeMirrored = false,
	maxLevel = nil,
}
local BOOLEAN_OPTIONS = { "includeCorrupted", "includeScourge", "includeTalisman", "includeMirrored" }
local ELDRITCH_VALUES = { ["None"] = true, ["Copy Current"] = true, ["Keep regular"] = true, ["Keep regular+presence"] = true, ["Remove"] = true }

-- Checks a request's options (nil or an object) and returns a full options table: the defaults with the
-- request's values on top.
function generator.readOptions(requested)
	if requested ~= nil and type(requested) ~= "table" then
		fail("bad-request", "options must be an object")
	end
	requested = requested or {}
	local options = {}
	for k, v in pairs(generator.DEFAULT_OPTIONS) do
		options[k] = v
	end
	for _, k in ipairs(BOOLEAN_OPTIONS) do
		if requested[k] ~= nil then
			if type(requested[k]) ~= "boolean" then
				fail("bad-request", "options." .. k .. " must be a boolean")
			end
			options[k] = requested[k]
		end
	end
	if requested.includeEldritch ~= nil then
		if not ELDRITCH_VALUES[requested.includeEldritch] then
			fail("bad-request", "options.includeEldritch must be one of None, Copy Current, Keep regular, Keep regular+presence, Remove")
		end
		options.includeEldritch = requested.includeEldritch
	end
	if requested.maxLevel ~= nil then
		local n = requested.maxLevel
		if type(n) ~= "number" or n < 1 or n % 1 ~= 0 then
			fail("bad-request", "options.maxLevel must be a whole number of at least 1")
		end
		options.maxLevel = n
	end
	return options
end

-- The two stat weights PoB's generator sums: damage (FullDPS for a Full DPS target, else CombinedDPS) and
-- TotalEHP.
function generator.statWeights(resolved, dpsWeight, ehpWeight)
	local damageStat = resolved.kind == "fullDps" and "FullDPS" or "CombinedDPS"
	return {
		{ label = damageStat, stat = damageStat, weightMult = dpsWeight },
		{ label = "Effective Hit Pool", stat = "TotalEHP", weightMult = ehpWeight },
	}
end

local function width(range)
	local lo, hi = tonumber(range.min), tonumber(range.max)
	if lo == nil or hi == nil then
		return -math.huge
	end
	return hi - lo
end

local function keyBefore(a, b)
	if type(a) == "number" and type(b) == "number" then
		return a < b
	end
	return tostring(a) < tostring(b)
end

-- The mods PoB's GenerateModWeights tests, one per trade stat, in a fixed order (V23). PoB walks its mod table
-- with pairs() and keeps the first entry it meets per trade stat, and QueryMods.lua often has several for one
-- stat in a category (894 of 6,144 at 2.68.1: hybrids, Maven and old mods beside the plain one). LuaJIT's
-- hash order changes with every worker, so which entry was tested (at the middle of its range) changed too,
-- and so did the weights. Here the entry with the widest range in the category wins (the plain mod over its
-- tiers: life 3..129 over the hybrids' 8..28; suppression 3..14 over the old 4..6 and Maven 16..18), ties going
-- to the lowest key (a mod before its "...Maven" twin). No duplicate pair differs in sign. Entries without
-- the category are left out, as PoB skips them. Returns an array, which pairs() walks in order.
function generator.onePerStat(modsToTest, category)
	local keys = {}
	for key in pairs(modsToTest) do
		table.insert(keys, key)
	end
	table.sort(keys, keyBefore)
	local chosen, order = {}, {}
	for _, key in ipairs(keys) do
		local entry = modsToTest[key]
		local range = entry[category]
		if range ~= nil then
			local id = entry.tradeMod.id
			local best = chosen[id]
			if best == nil then
				table.insert(order, id)
				chosen[id] = entry
			elseif width(range) > width(best[category]) then
				chosen[id] = entry
			end
		end
	end
	local list = {}
	for _, id in ipairs(order) do
		table.insert(list, chosen[id])
	end
	return list
end

-- Runs PoB's generator for a gear slot (PoB's slot object) and target. statWeights as from
-- generator.statWeights; options as from generator.readOptions. onProgress({ calcs, seconds }) is called every
-- 25 calcs. Returns the generator (modWeights, calcContext) and its result { query, err }, plus the calc
-- count, the seconds taken and the generator's log lines. The build is unchanged afterwards, even on error.
--
-- Every calc is counted through buildedit.withCalcHook. For a one-skill target it also turns the Full DPS
-- roll-up off: checked in one worker on RF, Animate - EarlyMid and Slamraxas, weights, query and
-- baseStatValue are bit-identical either way, and Animate's Gloves take about 1 s instead of 30 s.
-- GenerateModWeights gets its mods through generator.onePerStat, so the weights are the same in every worker.
function generator.run(slot, resolved, statWeights, options, onProgress)
	local log = json.array()
	local calcs = 0
	local started = os.clock()
	local realConPrintf = ConPrintf

	local function onCalc()
		calcs = calcs + 1
		if calcs % 25 == 0 then
			onProgress({ calcs = calcs, seconds = os.clock() - started })
		end
	end

	local function drive()
		local gen = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab })
		local result = nil
		gen.requesterCallback = function(_, queryTable, errMsg)
			result = { query = queryTable, err = errMsg }
		end
		gen.requesterContext = {}
		-- On the instance, so it shadows the class's method for this run only. The category is set by
		-- StartQuery, before the coroutine that calls this first runs.
		local realGenerate = gen.GenerateModWeights
		gen.GenerateModWeights = function(self, modsToTest)
			return realGenerate(self, generator.onePerStat(modsToTest, self.calcContext.itemCategory))
		end
		-- StartQuery writes into its options (the last max price and level from its GUI), so it gets a copy.
		local startOptions = { statWeights = statWeights }
		for k, v in pairs(options) do
			startOptions[k] = v
		end
		gen:StartQuery(slot, startOptions)
		-- As TradeQueryGenerator:OnFrame, but an error inside the coroutine is raised, not swallowed (V14).
		while gen.calcContext.co do
			local ok, errMsg = coroutine.resume(gen.calcContext.co, gen)
			if not ok then
				error("PoB's trade query generator failed: " .. tostring(errMsg), 0)
			end
			if coroutine.status(gen.calcContext.co) == "dead" then
				gen.calcContext.co = nil
				gen:FinishQuery()
			end
		end
		if not result then
			fail("generator-failed", "PoB's trade query generator returned nothing (" .. (log[#log] or "no log") .. ")")
		end
		return gen, result
	end

	ConPrintf = function(fmt, ...)
		local line = string.format(fmt, ...)
		table.insert(log, line)
		io.stderr:write(line, "\n")
	end
	local ok, gen, result = pcall(target.with, resolved, function(useFullDps)
		return buildedit.withCalcHook(useFullDps, onCalc, drive)
	end)
	ConPrintf = realConPrintf
	if not ok then
		error(gen, 0)
	end
	return { generator = gen, result = result, calcs = calcs, seconds = os.clock() - started, log = log }
end

return generator
