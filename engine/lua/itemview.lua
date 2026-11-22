-- An equipped item as the app's tooltip draws it (PLAN.md, Phase 4, gear layout): the same groups as
-- PoB's own tooltip (ItemsTab:AddItemTooltip), read from PoB's parsed item, so armour and weapon numbers
-- are PoB's computed ones. Mod lines go through itemLib.formatModLine (ranges applied, zero lines hidden)
-- with the colour codes stripped; each line's kind comes from its flags. The image and inventory size are
-- added by the app (PoB has no art paths).

local json = engineRequire("json")

local M = {}

-- PoB's influence keys, in its own order, as the app names them.
local INFLUENCES = {
	{ key = "shaper", id = "shaper" }, { key = "elder", id = "elder" }, { key = "adjudicator", id = "warlord" },
	{ key = "basilisk", id = "hunter" }, { key = "crusader", id = "crusader" }, { key = "eyrie", id = "redeemer" },
	{ key = "cleansing", id = "searing" }, { key = "tangle", id = "tangled" },
}

local function part(text, tone)
	return { text = text, tone = tone }
end

-- "Name: value", the value augmented (blue) when it differs from the base's.
local function prop(lines, name, value, base)
	local tone = (base ~= nil and value ~= base) and "augmented" or "plain"
	table.insert(lines, json.array({ part(name .. ": ", "label"), part(value, tone) }))
end

local function round(n)
	return tostring(math.floor(n + 0.5))
end

local function properties(item)
	local lines = json.array()
	local base = item.base or {}
	if item.quality and item.quality > 0 then
		table.insert(lines, json.array({ part("Quality: ", "label"), part(string.format("+%d%%", item.quality), "augmented") }))
	end
	if base.weapon and item.weaponData and item.weaponData[1] then
		local w = item.weaponData[1]
		if w.PhysicalMin and w.PhysicalMax and w.PhysicalMax > 0 then
			local bw = base.weapon
			local basePhys = (bw.PhysicalMin and bw.PhysicalMax) and string.format("%d-%d", bw.PhysicalMin, bw.PhysicalMax) or nil
			prop(lines, "Physical Damage", string.format("%d-%d", w.PhysicalMin, w.PhysicalMax), basePhys)
		end
		local elemental = json.array()
		for _, e in ipairs({ { "Fire", "fire" }, { "Cold", "cold" }, { "Lightning", "lightning" } }) do
			local min, max = w[e[1] .. "Min"], w[e[1] .. "Max"]
			if min and max and max > 0 then
				if #elemental > 0 then
					table.insert(elemental, part(", ", "label"))
				end
				table.insert(elemental, part(string.format("%d-%d", min, max), e[2]))
			end
		end
		if #elemental > 0 then
			table.insert(elemental, 1, part("Elemental Damage: ", "label"))
			table.insert(lines, elemental)
		end
		if w.ChaosMin and w.ChaosMax and w.ChaosMax > 0 then
			table.insert(lines, json.array({ part("Chaos Damage: ", "label"), part(string.format("%d-%d", w.ChaosMin, w.ChaosMax), "chaos") }))
		end
		if w.CritChance then
			prop(lines, "Critical Strike Chance", string.format("%.2f%%", w.CritChance), string.format("%.2f%%", base.weapon.CritChanceBase or w.CritChance))
		end
		if w.AttackRate then
			prop(lines, "Attacks per Second", string.format("%.2f", w.AttackRate), string.format("%.2f", base.weapon.AttackRateBase or w.AttackRate))
		end
	elseif base.armour and item.armourData then
		local a = item.armourData
		if base.armour.BlockChance and (a.BlockChance or 0) > 0 then
			prop(lines, "Chance to Block", string.format("%d%%", a.BlockChance), string.format("%d%%", base.armour.BlockChance))
		end
		for _, d in ipairs({ { "Armour", "Armour" }, { "Evasion", "Evasion Rating" }, { "EnergyShield", "Energy Shield" }, { "Ward", "Ward" } }) do
			local v = a[d[1]] or 0
			if v > 0 then
				prop(lines, d[2], round(v), round(a[d[1] .. "Base"] or v))
			end
		end
	end
	return lines
end

-- "Requires Level 70, Str 159, Int 98", as poe.ninja shows it.
local function requirements(item)
	local parts = json.array()
	local r = item.requirements or {}
	local function add(name, value)
		if value and value > 0 then
			table.insert(parts, part(#parts == 0 and ("Requires " .. name .. " ") or (", " .. name .. " "), "label"))
			table.insert(parts, part(tostring(value), "plain"))
		end
	end
	add("Level", r.level)
	add("Str", r.strMod or r.str)
	add("Dex", r.dexMod or r.dex)
	add("Int", r.intMod or r.int)
	return parts
end

-- "R-G-B B": linked sockets joined by "-", groups by a space.
local function sockets(item)
	local out, last = "", nil
	for _, s in ipairs(item.sockets or {}) do
		local colour = s.color or "?"
		if last == nil then
			out = colour
		elseif s.group == last then
			out = out .. "-" .. colour
		else
			out = out .. " " .. colour
		end
		last = s.group
	end
	return out
end

local function kindOf(modLine, groupKind)
	if groupKind == "enchant" or groupKind == "implicit" then
		return groupKind -- PoB flags anoints as crafted; the group says what they are
	elseif modLine.fractured then
		return "fractured"
	elseif modLine.crafted then
		return "crafted"
	elseif modLine.scourge then
		return "scourge"
	elseif modLine.crucible then
		return "crucible"
	end
	return groupKind
end

local function mods(item, list, groupKind)
	local out = json.array()
	for _, modLine in ipairs(list or {}) do
		local count = item:GetModLineVariantCount(modLine)
		if count > 0 then
			local formatted = itemLib.formatModLine(modLine)
			if formatted then
				local text = StripEscapes(formatted)
				for line in (text .. "\n"):gmatch("(.-)\n") do
					if line ~= "" then
						table.insert(out, { text = line, kind = kindOf(modLine, groupKind) })
					end
				end
			end
		end
	end
	return out
end

local RARITIES = { NORMAL = "normal", MAGIC = "magic", RARE = "rare", UNIQUE = "unique", RELIC = "unique" }

function M.build(item)
	local influences = json.array()
	for _, info in ipairs(INFLUENCES) do
		if item[info.key] then
			table.insert(influences, info.id)
		end
	end
	local baseName = (item.baseName or ""):gsub(" %(.+%)", "")
	local rarity = RARITIES[item.rarity or ""] or "other"
	local typeLine = baseName
	if rarity == "magic" then
		typeLine = (item.namePrefix or "") .. baseName .. (item.nameSuffix or "")
	end
	local explicits = mods(item, item.scourgeModLines, "scourge")
	for _, m in ipairs(mods(item, item.explicitModLines, "explicit")) do
		table.insert(explicits, m)
	end
	for _, m in ipairs(mods(item, item.crucibleModLines, "crucible")) do
		table.insert(explicits, m)
	end
	return {
		rarity = rarity,
		name = (rarity == "rare" or rarity == "unique") and (item.title or "") or "",
		typeLine = typeLine,
		baseName = baseName,
		influences = influences,
		properties = properties(item),
		requirements = requirements(item),
		sockets = sockets(item),
		itemLevel = item.itemLevel,
		enchants = mods(item, item.enchantModLines, "enchant"),
		implicits = mods(item, item.implicitModLines, "implicit"),
		explicits = explicits,
		corrupted = item.corrupted and true or false,
		mirrored = item.mirrored and true or false,
	}
end

return M
