-- The uniques PoB knows for one item type, each scored in the build and weighted by its own rolls (#113, V29).
--
-- For each unique (current variant, as PoB's unique DB holds it):
--   * scoreLow / scoreMid / scoreHigh: PoB's generator score (WeightedRatioOutputs x 1000, the run's target
--     and blend) with every rolling line at its lowest, middle and highest roll;
--   * change: scoreHigh minus the equipped item's score;
--   * weights: per rolling line, the gain per point of the site's value for that line (the mean of its numbers,
--     in the places the site's text has "#"), with every other line held mid. A line matched through the
--     increased/reduced swap is read in the site's wording, so its weight has the site's sign. Lines that gain
--     nothing are left out; lines that grant a skill or inflict Decay are skipped, as PoB's generator skips them;
--   * rolls: every matched rolling line's site value at its lowest and highest roll;
--   * statIds: every line's trade stat id, rolling or not (for the hard-need check);
--   * unmatched: rolling lines with no trade stat id.
--
-- Trade stat ids come from the lines' text the way PoB's generator matches mods (TradeQueryGenerator:ProcessMod):
-- numbers and signs stripped, the "(Local)" entry first on weapons and on defence and block lines, then the plain
-- entry, then the increased/reduced swap (TradeHelpers.swapInverse).
--
-- Items are scored as plain item texts parsed the way the dispatcher parses trade listings (20% quality), so a
-- unique here scores as a listed copy with the same rolls would.

local json = engineRequire("json")
local slotdata = engineRequire("slotdata")
local target = engineRequire("target")
local tradeHelpers = require("Classes.TradeHelpers")

local uniques = {}

local LOCAL_WORDS = { "Armour", "Evasion", "Energy Shield", "Chance to Block", "Ward" }
local RANGE = "%(%-?[%d%.]+%-%-?[%d%.]+%)"
local DB_FRAME_LIMIT = 1000

local entriesByType = nil

local function tradeEntries(kind)
	if not entriesByType then
		entriesByType = {}
		for _, cat in ipairs(require("Data.TradeSiteStats")) do
			local first = cat.entries[1]
			if first and first.type then
				entriesByType[first.type] = cat.entries
			end
		end
	end
	return entriesByType[kind] or {}
end

local function stripped(text)
	return (text:gsub("[#()0-9%-%+%.]", ""))
end

local function looksLocal(line, isWeapon)
	if isWeapon then
		return true
	end
	for _, word in ipairs(LOCAL_WORDS) do
		if line:find(word, 1, true) then
			return true
		end
	end
	return false
end

local function search(entries, line, isWeapon)
	if looksLocal(line, isWeapon) then
		local wanted = stripped(line .. " (Local)")
		for _, e in ipairs(entries) do
			if stripped(e.text) == wanted then
				return e
			end
		end
	end
	local wanted = stripped(line)
	for _, e in ipairs(entries) do
		if stripped(e.text) == wanted then
			return e
		end
	end
	return nil
end

-- The trade stat entry for a line (a concrete roll, not a range) and whether it matched through the swap.
local function tradeStat(line, kind, isWeapon)
	local entries = tradeEntries(kind)
	local entry = search(entries, line, isWeapon)
	if entry then
		return entry, false
	end
	local swapped, key = tradeHelpers.swapInverse(line)
	if key then
		entry = search(entries, swapped, isWeapon)
		if entry then
			return entry, true
		end
	end
	return nil, false
end

local function hasRange(line)
	return line:find(RANGE) ~= nil
end

local function meanOf(numbers)
	local sum = 0
	for _, n in ipairs(numbers) do
		sum = sum + n
	end
	return #numbers > 0 and sum / #numbers or nil
end

-- The site's value for a concrete line of a stat: the mean of the numbers in the places the site's text has
-- "#" ("# to # Added Attack Chaos Damage per 100 Maximum Mana" counts the two damage numbers, not the 100). A
-- line matched through the increased/reduced swap is read in the site's wording, so "20% reduced" is -20. If the
-- line doesn't line up with the site's text, every number in it counts (negated for a swapped line).
local function siteValue(line, entry, inverted)
	local text = inverted and tradeHelpers.swapInverse(line) or line
	local pattern = "^"
		.. entry.text:gsub(" %(Local%)$", ""):gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0"):gsub("#", "([%%+%%-]?[%%d%%.]+)")
		.. "$"
	local captured = { text:match(pattern) }
	local numbers = {}
	for _, c in ipairs(captured) do
		local n = tonumber(c)
		if n then
			table.insert(numbers, n)
		end
	end
	if #numbers > 0 then
		return meanOf(numbers)
	end
	for n in line:gmatch("%-?%d+%.?%d*") do
		table.insert(numbers, inverted and -tonumber(n) or tonumber(n))
	end
	return meanOf(numbers)
end

local function skipped(line)
	return line:find("Grants Level") ~= nil or line:find("inflict Decay") ~= nil
end

local function activeLines(item, list)
	local out = {}
	for _, ml in ipairs(list or {}) do
		if not ml.variantList or ml.variantList[item.variant] then
			table.insert(out, ml)
		end
	end
	return out
end

local function waitForDb()
	local frames = 0
	while main.uniqueDB.loading do
		if frames >= DB_FRAME_LIMIT then
			error({ code = "internal", message = "PoB's unique list never finished loading" }, 0)
		end
		runCallback("OnFrame")
		frames = frames + 1
	end
end

-- A plain item text of the unique with each ranged line at the roll rollOf(kind, index) gives (0 to 1).
local function itemText(item, implicits, explicits, rollOf)
	local lines = { "Rarity: UNIQUE", item.title, item.baseName, "Implicits: " .. #implicits }
	for i, ml in ipairs(implicits) do
		table.insert(lines, hasRange(ml.line) and itemLib.applyRange(ml.line, rollOf("implicit", i)) or ml.line)
	end
	for i, ml in ipairs(explicits) do
		table.insert(lines, hasRange(ml.line) and itemLib.applyRange(ml.line, rollOf("explicit", i)) or ml.line)
	end
	return table.concat(lines, "\n")
end

local function parsed(text)
	local it = new("Item"):Item(text)
	it:NormaliseQuality()
	it:BuildModList()
	return it
end

local function allAt(roll)
	return function()
		return roll
	end
end

local function oneAt(kind, index, roll)
	return function(k, i)
		if k == kind and i == index then
			return roll
		end
		return 0.5
	end
end

local function analyse(item, score)
	local isWeapon = item.base.weapon ~= nil
	local implicits = activeLines(item, item.implicitModLines)
	local explicits = activeLines(item, item.explicitModLines)
	local function scoreAt(rollOf)
		return score(parsed(itemText(item, implicits, explicits, rollOf)))
	end
	local weights, rolls, statIds, unmatched = json.array(), json.array(), json.array(), json.array()
	local seenIds = {}
	for _, group in ipairs({ { "implicit", implicits }, { "explicit", explicits } }) do
		local kind, list = group[1], group[2]
		for index, ml in ipairs(list) do
			local low = hasRange(ml.line) and itemLib.applyRange(ml.line, 0) or ml.line
			local entry, inverted = tradeStat(low, kind, isWeapon)
			if entry and not seenIds[entry.id] then
				seenIds[entry.id] = true
				table.insert(statIds, entry.id)
			end
			if hasRange(ml.line) and not skipped(ml.line) then
				if not entry then
					table.insert(unmatched, ml.line)
				else
					local high = itemLib.applyRange(ml.line, 1)
					local vLow, vHigh = siteValue(low, entry, inverted), siteValue(high, entry, inverted)
					if vLow and vHigh then
						table.insert(rolls, { id = entry.id, line = ml.line, low = vLow, high = vHigh })
					end
					-- The weight is per point of the site's value, so a swapped line's weight has the site's sign.
					-- A line whose site value doesn't move (a range across zero) can't be weighed.
					local span = (vLow and vHigh) and (vHigh - vLow) or 0
					if span ~= 0 then
						local gain = scoreAt(oneAt(kind, index, 1)) - scoreAt(oneAt(kind, index, 0))
						if gain > 0 then
							table.insert(weights, { id = entry.id, weight = gain / span, line = ml.line })
						end
					end
				end
			end
		end
	end
	table.sort(weights, function(a, b)
		if math.abs(a.weight) ~= math.abs(b.weight) then
			return math.abs(a.weight) > math.abs(b.weight)
		end
		return a.id < b.id
	end)
	return {
		name = item.title,
		base = item.baseName,
		tradeType = slotdata.tradeType(item.baseName),
		variant = item.variant,
		variants = item.variantList and #item.variantList or 1,
		scoreLow = scoreAt(allAt(0)),
		scoreMid = scoreAt(allAt(0.5)),
		scoreHigh = scoreAt(allAt(1)),
		weights = weights,
		rolls = rolls,
		statIds = statIds,
		unmatched = unmatched,
	}
end

-- The unique's Foulborn versions (pob-internals P31): one per line PoB's Foulborn map can mutate, on the current
-- variant. Each is a copy of the unique with that line swapped by PoB's own MutateMod, so it is scored and
-- weighted like any unique, the mutated line in the swapped one's place. `foulborn` says which version it is:
-- the mutated mod's id, its text and its trade stat id (nil when the site has none: the search then can't tell
-- this version from the unique's other Foulborn versions).
local function foulbornVersions(item, score)
	local out = {}
	local seen = {}
	for _, ml in ipairs(activeLines(item, item.explicitModLines)) do
		local mod = ml.newModId and not ml.mutated and data.itemMods.Foulborn[ml.newModId]
		if mod and not seen[ml.newModId] then
			seen[ml.newModId] = true
			local copy = new("Item"):Item(item:BuildRaw())
			copy:MutateMod(ml.modId, ml.newModId, true)
			local text = table.concat(mod, "\n")
			local low = hasRange(mod[1]) and itemLib.applyRange(mod[1], 0) or mod[1]
			local entry = tradeStat(low, "explicit", item.base.weapon ~= nil)
			local info = analyse(copy, score)
			info.name = item.title
			info.foulborn = { modId = ml.newModId, line = text, statId = entry and entry.id or nil }
			table.insert(out, info)
		end
	end
	return out
end

-- Every unique of PoB's item type `itemType`, analysed in slot `slotName` under `resolved` (target.resolve),
-- with the generator's stat weights, each followed by its Foulborn versions. Sorted by name.
function uniques.list(slotName, itemType, resolved, statWeights)
	waitForDb()
	local slot = build.itemsTab.slots[slotName]
	local equipped = slot and build.itemsTab.items[slot.selItemId]
	local ratio = new("TradeQueryGenerator"):TradeQueryGenerator({ itemsTab = build.itemsTab }).WeightedRatioOutputs
	return target.with(resolved, function(useFullDps)
		local calcFunc = build.calcsTab:GetMiscCalculator()
		local baseOutput = calcFunc({}, useFullDps)
		local function score(item)
			return ratio(baseOutput, calcFunc({ repSlotName = slotName, repItem = item }, useFullDps), statWeights) * 1000
		end
		-- An empty slot: the build as it is, which is the base itself.
		local equippedScore = equipped and score(equipped) or ratio(baseOutput, baseOutput, statWeights) * 1000
		local out = json.array()
		for _, item in pairs(main.uniqueDB.list) do
			if item.base and item.base.type == itemType then
				local info = analyse(item, score)
				info.change = info.scoreHigh - equippedScore
				table.insert(out, info)
				for _, version in ipairs(foulbornVersions(item, score)) do
					version.change = version.scoreHigh - equippedScore
					table.insert(out, version)
				end
			end
		end
		-- By name, then base: several uniques share a name (Doryani's Delusion has three boots). The plain unique
		-- comes before its Foulborn versions, which go by their mutated mod's id.
		table.sort(out, function(a, b)
			if a.name ~= b.name then
				return a.name < b.name
			end
			if a.base ~= b.base then
				return a.base < b.base
			end
			local fa, fb = a.foulborn and a.foulborn.modId or "", b.foulborn and b.foulborn.modId or ""
			return fa < fb
		end)
		return out
	end)
end

return uniques
