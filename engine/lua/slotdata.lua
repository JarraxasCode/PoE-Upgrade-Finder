-- Slot data from PoB's own data (PLAN.md, Phase 6; V18 made real): for one base type, every base with
-- its implicits, and which affix, eldritch and corrupted mods can roll on it, with and without each
-- influence, using PoB's craft-screen rule (Item:GetModSpawnWeight > 0 over the base's affix pool).
--
-- Each mod's trade stat ids come from its hashes when the site knows them all, else from its lines'
-- text against the site's list (PoB's bundled Data/TradeSiteStats). Each id is then matched to the mod
-- line that carries it, which gives its roll range in the site's terms: a line worded "reduced"/"less"/
-- "slower" against the site's "increased"/"more"/"faster" is negated (V18, V24). Mods with no trade id
-- are left out and counted.
--
-- Besides natural rolls, every source PoB's own "Add modifier" screen offers for the item (ItemsTab,
-- AddCustomModifierToDisplayItem) is listed, each family tagged with its source (issue #32): fossil
-- (natural, Delve-only affix), crafted (bench), essence (essence-only mods), veiled, beast, necropolis,
-- delve and incursion (drop-restricted). Same applicability rules as PoB's screen.

local json = engineRequire("json")

local slotdata = {}

-- The site's `type` for a base: PoB's name without its bracketed variant (V24), e.g. "Two-Toned Boots
-- (Armour/Evasion)" is "Two-Toned Boots".
function slotdata.tradeType(name)
	return (name:gsub("%s*%b()$", ""))
end

local AFFIX_CATEGORY = { Prefix = "explicit", Suffix = "explicit", Exarch = "implicit", Eater = "implicit", Corrupted = "implicit" }
local SKIP_TYPES = { Flask = true, Tincture = true, Jewel = true, Graft = true, Viscera = true, ["Fishing Rod"] = true }
local INFLUENCES = { "shaper", "elder", "adjudicator", "basilisk", "crusader", "eyrie" }
local FLIP_WORDS = { reduced = "increased", less = "more", slower = "faster" }
-- The slot plan's defence names → PoB's armour table fields (<Field>BaseMin / <Field>BaseMax).
local DEFENCE_FIELDS = { armour = "Armour", evasion = "Evasion", energyShield = "EnergyShield", ward = "Ward" }
-- Where a source's lines sit on the trade site when the explicit stat list has no id for them.
local SOURCE_CATEGORY = { crafted = "crafted", veiled = "veiled", delve = "delve" }
local delveDropOnly = require("Data.DelveDropOnly")
local incursionDropOnly = require("Data.IncursionDropOnly")

-- A PoB data table the slot data reads. One PoB renamed or dropped is an error naming it (issue #66), never an
-- empty table: `or {}` here would quietly empty a mod source (the bench, essences, ...) after a PoB update. An
-- error, not a warning, because the client caches slot data per PoB version and logs only a warning count: a
-- short result would stick. The error reaches the user ("Couldn't read PoB's mods for ..."), and the PoB
-- update's smoke check stops such a copy before it goes live.
local function pobTable(value, name)
	if type(value) ~= "table" then
		error({ code = "pob-data", message = "PoB has no " .. name .. " table (renamed or dropped in this PoB version?)" }, 0)
	end
	return value
end

-- The site's stat list, loaded once: id -> text, and "<category>|<text with #>" -> id.
local site = nil
local function siteStats()
	if site then
		return site
	end
	site = { text = {}, byText = {} }
	local effects = {}
	for _, group in ipairs(require("Data.TradeSiteStats")) do
		for _, entry in ipairs(group.entries) do
			site.text[entry.id] = entry.text
			local key = entry.type .. "|" .. entry.text
			if entry.id:find("%.stat_") then
				if not site.byText[key] then
					site.byText[key] = entry.id
				end
			elseif entry.id:find("%.effect_") and not effects[key] then
				-- "Grants Level # Aspect of the Cat" (beastcrafts, skill grants): only when no stat_ id reads the same.
				effects[key] = entry.id
			end
		end
	end
	for key, id in pairs(effects) do
		if not site.byText[key] then
			site.byText[key] = id
		end
	end
	return site
end

-- A mod line as the site writes it: rolls and numbers become #.
local function hashText(line)
	return (line:gsub("%(%-?[%d%.]+%-%-?[%d%.]+%)", "#"):gsub("%d+%.?%d*", "#"))
end

-- Tokens for matching a line to a site text, with the roll behind each # token. Numbers and rolls become
-- #, "a"/"an" become # (a roll of 1), "(Local)", signs and plurals are dropped, and flip words read as
-- their opposite (`flips` counts them).
local function tokens(text)
	local values = {}
	local function mark(sign, lo, hi)
		local a, b = tonumber(lo), tonumber(hi)
		if a == nil or b == nil then
			return " "
		end
		if sign == "-" then
			a, b = -a, -b
		end
		if a > b then
			a, b = b, a
		end
		table.insert(values, { a, b })
		return " \1" .. string.char(64 + #values) .. " "
	end
	local s = text:lower():gsub("%(local%)", " ")
	s = s:gsub("([%+%-]?)%((%-?[%d%.]+)%-(%-?[%d%.]+)%)", mark)
	s = s:gsub("([%+%-]?)(%d+%.?%d*)", function(sign, n)
		return mark(sign, n, n)
	end)
	s = s:gsub("[%+%-]?#", " # "):gsub("%%", " %% "):gsub("[^%a#%%\1 ]", " ")
	local list, rolls, flips = {}, {}, 0
	for w in s:gmatch("%S+") do
		local roll = nil
		if w:sub(1, 1) == "\1" then
			roll = values[w:byte(2) - 64]
			w = "#"
		elseif w == "a" or w == "an" then
			roll = { 1, 1 }
			w = "#"
		elseif FLIP_WORDS[w] then
			w = FLIP_WORDS[w]
			flips = flips + 1
		end
		if w ~= "#" and w ~= "%" then
			w = w:gsub("s$", "")
		end
		table.insert(list, w)
		if w == "#" then
			table.insert(rolls, roll or false)
		end
	end
	return table.concat(list, " "), rolls, flips
end

local function firstRoll(line)
	local _, rolls = tokens(line)
	for _, r in ipairs(rolls) do
		if r then
			return r
		end
	end
	return nil
end

-- The roll behind a stat on a line: the average of the line's rolls at the site text's bare # (two for
-- "Adds # to #"; a number the site writes out, like "per 10 Dexterity", is not a roll), negated when the
-- line's wording is the opposite of the site's.
local function statOnLines(lines, siteText)
	local siteKey, siteRolls, siteFlips = tokens(siteText)
	for index, line in ipairs(lines) do
		local key, rolls, lineFlips = tokens(line)
		if key == siteKey then
			local lo, hi, n = 0, 0, 0
			for i, r in ipairs(rolls) do
				if r and not siteRolls[i] then
					lo, hi, n = lo + r[1], hi + r[2], n + 1
				end
			end
			local negate = lineFlips > siteFlips
			local range = nil
			if n > 0 then
				lo, hi = lo / n, hi / n
				range = negate and json.array({ -hi, -lo }) or json.array({ lo, hi })
			end
			return index - 1, negate, range
		end
	end
	-- No line words it like the site (about 0.4% of ids, odd wordings): a one-line mod is that line.
	if #lines == 1 then
		local r = firstRoll(lines[1])
		return 0, false, r and json.array({ r[1], r[2] }) or nil
	end
	return nil, false, nil
end

local function sortedHashes(mod)
	local list = {}
	for hash in pairs(mod.tradeHashes or {}) do
		table.insert(list, hash)
	end
	table.sort(list)
	return list
end

-- The ways the site may word a line, most likely first: every number as #; only the rolls and the first
-- number as # (the site keeps fixed numbers like "for 4 seconds"); each with "(Local)" (bench crafts carry no
-- trade hashes, and the site words local defences that way); and "reduced" read as "increased".
local function textCandidates(line)
	local list, seen = {}, {}
	local function add(text)
		if text and not seen[text] then
			seen[text] = true
			table.insert(list, text)
		end
	end
	local rollsOnly = line:gsub("%(%-?[%d%.]+%-%-?[%d%.]+%)", "#")
	local firstOnly = rollsOnly
	if not rollsOnly:find("#") then
		firstOnly = rollsOnly:gsub("%d+%.?%d*", "#", 1)
	end
	for _, text in ipairs({ hashText(line), rollsOnly, firstOnly }) do
		add(text)
		add(text .. " (Local)")
		local flipped = text:gsub("reduced", "increased")
		if flipped ~= text then
			add(flipped)
			add(flipped .. " (Local)")
		end
	end
	return list
end

-- A mod's trade ids, deduped: by hash when the site knows every hash, else by each line's text.
local function tradeIdsOf(mod, category)
	local s = siteStats()
	local ids, seen = {}, {}
	local function add(id)
		if not seen[id] then
			seen[id] = true
			table.insert(ids, id)
		end
	end
	local hashes = sortedHashes(mod)
	local allKnown = #hashes > 0
	for _, hash in ipairs(hashes) do
		if not s.text[category .. ".stat_" .. hash] then
			allKnown = false
		end
	end
	if allKnown then
		for _, hash in ipairs(hashes) do
			add(category .. ".stat_" .. hash)
		end
		return ids, "hash"
	end
	for _, line in ipairs(mod) do
		local id = nil
		for _, text in ipairs(textCandidates(line)) do
			id = s.byText[category .. "|" .. text]
			if id then
				break
			end
		end
		if id then
			add(id)
		end
	end
	return ids, "text"
end

local function statsOf(mod, ids)
	local s = siteStats()
	local lines = { unpack(mod) }
	local stats = json.array()
	for _, id in ipairs(ids) do
		local line, negate, range = statOnLines(lines, s.text[id] or "")
		table.insert(stats, { id = id, text = s.text[id], line = line, negate = negate, range = range })
	end
	return stats
end

-- Every base type with bases (types the editor never shows are left out).
function slotdata.baseTypes()
	local counts = {}
	for _, base in pairs(pobTable(data.itemBases, "data.itemBases")) do
		if not SKIP_TYPES[base.type] and not base.hidden then
			counts[base.type] = (counts[base.type] or 0) + 1
		end
	end
	local list = json.array()
	for name, n in pairs(counts) do
		table.insert(list, { baseType = name, bases = n })
	end
	table.sort(list, function(a, b)
		return a.baseType < b.baseType
	end)
	return list
end

function slotdata.build(baseType)
	local started = os.clock()
	local names = {}
	for name, base in pairs(pobTable(data.itemBases, "data.itemBases")) do
		if base.type == baseType and not base.hidden then
			table.insert(names, name)
		end
	end
	if #names == 0 or SKIP_TYPES[baseType] then
		return nil
	end
	table.sort(names)
	local itemMods = pobTable(data.itemMods, "data.itemMods")
	local implicitMods = pobTable(itemMods.ItemExclusive, "data.itemMods.ItemExclusive")
	local delveMods = pobTable(itemMods.Delve, "data.itemMods.Delve")
	local explicitMods = pobTable(itemMods.Explicit, "data.itemMods.Explicit")
	local masterMods = pobTable(data.masterMods, "data.masterMods")
	local essences = pobTable(data.essences, "data.essences")
	local veiledMods = pobTable(data.veiledMods, "data.veiledMods")
	local beastCraft = pobTable(data.beastCraft, "data.beastCraft")
	local necropolisMods = pobTable(data.necropolisMods, "data.necropolisMods")

	local mods = {}        -- modId -> mod entry
	local familyIndex = {} -- key -> 0-based index into families
	local families = json.array()
	local unmatched = json.array()
	local unmatchedSeen = {}
	local pools = json.array()
	local poolIndex = {}   -- signature -> 0-based index

	-- Adds a mod once; false when it has no trade id (left out). source: "natural", "fossil", "crafted", ...
	local function addMod(modId, mod, source)
		if mods[modId] ~= nil then
			return mods[modId] ~= false
		end
		local ids, via = tradeIdsOf(mod, AFFIX_CATEGORY[mod.type])
		if #ids == 0 and SOURCE_CATEGORY[source] then
			ids, via = tradeIdsOf(mod, SOURCE_CATEGORY[source])
		end
		if #ids == 0 then
			mods[modId] = false
			if not unmatchedSeen[modId] then
				unmatchedSeen[modId] = true
				table.insert(unmatched, { modId = modId, type = mod.type, lines = json.array({ unpack(mod) }) })
			end
			return false
		end
		local key = source .. "|" .. mod.type .. "|" .. tostring(mod.group) .. "|" .. table.concat(ids, ",")
		local index = familyIndex[key]
		if index == nil then
			local siteTexts = json.array()
			for _, id in ipairs(ids) do
				table.insert(siteTexts, siteStats().text[id])
			end
			table.insert(families, {
				type = mod.type, group = mod.group, source = source, text = hashText(table.concat({ unpack(mod) }, " / ")),
				tradeIds = json.array(ids), siteTexts = siteTexts, tiers = json.array(),
			})
			index = #families - 1
			familyIndex[key] = index
		end
		table.insert(families[index + 1].tiers, modId)
		mods[modId] = {
			type = mod.type, family = index, level = mod.level or 1, lines = json.array({ unpack(mod) }),
			via = via, stats = statsOf(mod, ids),
		}
		return true
	end

	local function sharedPool(ids)
		local sig = table.concat(ids, ",")
		local index = poolIndex[sig]
		if index == nil then
			table.insert(pools, json.array(ids))
			index = #pools - 1
			poolIndex[sig] = index
		end
		return index
	end

	local bases = json.array()
	for _, name in ipairs(names) do
		local base = data.itemBases[name]
		local item = new("Item"):Item("Rarity: RARE\nSlot data\n" .. name)
		local tags = json.array()
		for tag in pairs(base.tags or {}) do
			table.insert(tags, tag)
		end
		table.sort(tags)
		local implicits = json.array()
		for _, implicitId in ipairs(base.implicitIds or {}) do
			local mod = implicitMods[implicitId]
			if mod then
				local ids = {}
				for _, hash in ipairs(sortedHashes(mod)) do
					if siteStats().text["implicit.stat_" .. hash] then
						table.insert(ids, "implicit.stat_" .. hash)
					end
				end
				table.insert(implicits, { modId = implicitId, lines = json.array({ unpack(mod) }), stats = statsOf(mod, ids) })
			end
		end

		local function poolFor(influence)
			local ids = {}
			if influence then
				item[influence] = true
			end
			for modId, mod in pairs(pobTable(item.affixes, "item.affixes (" .. name .. ")")) do
				local source = item:CheckIfModIsDelve(mod) and "fossil" or "natural"
				if AFFIX_CATEGORY[mod.type] and item:GetModSpawnWeight(mod) > 0 and addMod(modId, mod, source) then
					table.insert(ids, modId)
				end
			end
			if influence then
				item[influence] = nil
			end
			table.sort(ids)
			return ids
		end

		local plain = poolFor(nil)
		-- The other sources, on the plain pool (no influence needed), as PoB's "Add modifier" screen has them.
		local function addSource(source, modId, mod)
			if mod and (mod.type == "Prefix" or mod.type == "Suffix") and addMod(source .. ":" .. modId, mod, source) then
				table.insert(plain, source .. ":" .. modId)
			end
		end
		for i, craft in ipairs(masterMods) do
			if craft.types and craft.types[item.type] then
				addSource("crafted", tostring(i), craft)
			end
		end
		for _, essence in pairs(essences) do
			local modId = essence.mods and essence.mods[item.type]
			local mod = modId and item.affixes[modId]
			-- An essence mod that also rolls naturally is already listed as natural.
			if mod and item:GetModSpawnWeight(mod) <= 0 then
				addSource("essence", modId, mod)
			end
		end
		for modId, mod in pairs(veiledMods) do
			if item:GetModSpawnWeight(mod) > 0 then
				addSource("veiled", modId, mod)
			end
		end
		for modId, mod in pairs(beastCraft) do
			addSource("beast", modId, mod)
		end
		if baseType == "Helmet" or baseType == "Body Armour" or baseType == "Gloves" or baseType == "Boots" then
			for modId, mod in pairs(necropolisMods) do
				if item:GetNecropolisModSpawnWeight(mod) > 0 then
					addSource("necropolis", modId, mod)
				end
			end
		end
		local subTypeName = base.subType and (base.type .. ": " .. base.subType)
		local function dropRestricted(source, categories, modDb)
			for modId, entry in pairs(categories) do
				for _, cat in ipairs(entry.categories or {}) do
					if cat == base.type or cat == subTypeName then
						addSource(source, modId, modDb[modId])
						break
					end
				end
			end
		end
		dropRestricted("delve", delveDropOnly, delveMods)
		dropRestricted("incursion", incursionDropOnly, explicitMods)
		table.sort(plain)
		local plainSet = {}
		for _, id in ipairs(plain) do
			plainSet[id] = true
		end
		local basePools = { none = sharedPool(plain) }
		if base.influenceTags then
			for _, influence in ipairs(INFLUENCES) do
				local extra = {}
				for _, id in ipairs(poolFor(influence)) do
					if not plainSet[id] then
						table.insert(extra, id)
					end
				end
				basePools[influence] = sharedPool(extra)
			end
		end
		-- The base's own defence rolls (PoB's armour table, before quality and mods), only those it has.
		local defences = {}
		local armour = base.armour or {}
		for key, field in pairs(DEFENCE_FIELDS) do
			local lo, hi = armour[field .. "BaseMin"], armour[field .. "BaseMax"]
			if lo and hi and hi > 0 then
				defences[key] = json.array({ lo, hi })
			end
		end
		table.insert(bases, {
			name = name,
			defences = defences,
			tradeType = slotdata.tradeType(name),
			subType = base.subType,
			level = base.req and base.req.level or 0,
			tags = tags,
			implicits = implicits,
			pools = basePools,
		})
	end

	for _, family in ipairs(families) do
		table.sort(family.tiers, function(a, b)
			local la, lb = mods[a].level, mods[b].level
			if la ~= lb then
				return la < lb
			end
			return a < b
		end)
	end
	table.sort(unmatched, function(a, b)
		return a.modId < b.modId
	end)
	local modTable = {}
	local modCount = 0
	for modId, mod in pairs(mods) do
		if mod then
			modTable[modId] = mod
			modCount = modCount + 1
		end
	end
	return {
		baseType = baseType,
		bases = bases,
		pools = pools,
		families = families,
		mods = modTable,
		unmatched = unmatched,
		counts = { bases = #names, mods = modCount, families = #families, pools = #pools, unmatched = #unmatched },
		seconds = os.clock() - started,
	}
end

return slotdata
