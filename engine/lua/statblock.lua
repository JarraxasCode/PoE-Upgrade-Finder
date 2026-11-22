-- The stat block: the PoB output keys the app reads (PLAN.md, "What we read"), taken from the table the
-- compare calculator returns. A key PoB leaves out stays out (PoB uses absence as information: NetLifeRegen
-- is present only when the build has a degen, the immunity flags only when true). Nested keys are flattened
-- with a dot ("Minion.CombinedDPS", "MainHand.Speed"). Values are numbers or booleans; anything else
-- (strings, item objects) is skipped.

local json = engineRequire("json")

local statblock = {}

local elements = { "Fire", "Cold", "Lightning" }
local damageTypes = { "Physical", "Fire", "Cold", "Lightning", "Chaos" }
local ailments = { "Ignite", "Shock", "Freeze", "Bleed", "Poison" }

local keys = {
	-- Damage
	"FullDPS", "FullDotDPS", "CombinedDPS", "TotalDPS", "TotalDotDPS", "TotalDot",
	"IgniteDPS", "BleedDPS", "PoisonDPS", "TotalPoisonDPS", "BurningGroundDPS", "ImpaleDPS",
	-- Ailment offence
	"IgniteChance", "ShockChance", "FreezeChance", "BleedChance", "ImpaleChance",
	"CritChance", "CritMultiplier", "Speed", "HitChance", "Accuracy",
	-- Effective HP
	"TotalEHP", "SecondMinimalMaximumHitTaken",
	-- Defences
	"Life", "EnergyShield", "Ward", "Armour", "Evasion",
	"BlockChance", "SpellBlockChance", "BlockChanceMax", "SpellBlockChanceMax", "BlockChanceOverCap", "SpellBlockChanceOverCap",
	"EffectiveBlockChance", "EffectiveSpellBlockChance",
	"SpellSuppressionChance", "SpellSuppressionChanceOverCap", "SpellSuppressionEffect",
	"ChaosResist", "ChaosResistTotal", "MissingChaosResist", "ChaosResistOverCap",
	-- Avoidance
	"FreezeAvoidChance", "ShockAvoidChance", "IgniteAvoidChance", "ChillAvoidChance", "BleedAvoidChance",
	"PoisonAvoidChance", "StunAvoidChance", "CurseAvoidChance", "BlindAvoidChance", "ImpaleAvoidChance",
	"CorruptedBloodImmunity", "MaimImmunity", "HinderImmunity", "KnockbackImmunity",
	-- Recovery
	"LifeRegenRecovery", "EnergyShieldRegenRecovery", "LifeRegen",
	"NetLifeRegen", "NetEnergyShieldRegen", "TotalNetRegen", "TotalBuildDegen",
	"LifeLeechGainRate", "MaxLifeLeechRate", "LifeRecoup", "anyRecoup",
	-- Utility
	"EffectiveMovementSpeedMod", "MovementSpeedMod", "ActionSpeedMod",
	"Str", "Dex", "Int", "ReqStr", "ReqDex", "ReqInt",
	"Mana", "ManaUnreserved", "ManaReserved", "ManaReservedPercent", "LifeReserved", "LifeUnreserved", "ManaCost", "LifeCost",
}
for _, a in ipairs(ailments) do
	table.insert(keys, a .. "ChanceOnHit")
	table.insert(keys, a .. "ChanceOnCrit")
end
for _, t in ipairs(damageTypes) do
	table.insert(keys, t .. "MaximumHitTaken")
end
for _, el in ipairs(elements) do
	for _, suffix in ipairs({ "Resist", "ResistTotal", "ResistOverCap" }) do
		table.insert(keys, el .. suffix)
	end
	table.insert(keys, "Missing" .. el .. "Resist")
end

-- Per hand (attacks keep these per hand only) and the minion's own output.
local handKeys = { "Speed", "Accuracy", "HitChance", "CritChance", "CritMultiplier" }
for _, a in ipairs(ailments) do
	table.insert(handKeys, a .. "ChanceOnHit")
	table.insert(handKeys, a .. "ChanceOnCrit")
end
local minionKeys = {
	"CombinedDPS", "TotalDPS", "TotalDotDPS", "IgniteDPS", "BleedDPS", "TotalPoisonDPS", "ImpaleDPS",
	"CritChance", "CritMultiplier", "Speed", "HitChance", "TotalEHP", "Life", "EnergyShield",
}
local nested = { MainHand = handKeys, OffHand = handKeys, Minion = minionKeys }

statblock.keys = keys

local function put(values, name, v)
	local tv = type(v)
	if tv == "number" or tv == "boolean" then
		values[name] = v
	end
end

-- Reads one dotted path ("Minion.CombinedDPS") from an output table.
local function lookup(out, path)
	local v = out
	for part in path:gmatch("[^%.]+") do
		if type(v) ~= "table" then
			return nil
		end
		v = v[part]
	end
	return v
end

-- The damage number for a resolved target (target.lua): FullDPS for Full DPS, else the main skill's
-- CombinedDPS plus its minion's. FullDPS is never read for a one-skill target (TREE view leaves it set).
function statblock.damageOf(out, target)
	if target.kind == "fullDps" then
		return out.FullDPS or 0
	end
	return (out.CombinedDPS or 0) + (type(out.Minion) == "table" and out.Minion.CombinedDPS or 0)
end

-- Builds a stat block from a compare-calculator output table.
-- extraKeys: optional list of more dotted paths to include. withSkillDps adds the SkillDPS rows.
function statblock.build(out, target, extraKeys, withSkillDps)
	local values = {}
	for _, k in ipairs(keys) do
		put(values, k, out[k])
	end
	for group, list in pairs(nested) do
		local t = out[group]
		if type(t) == "table" then
			for _, k in ipairs(list) do
				put(values, group .. "." .. k, t[k])
			end
		end
	end
	for _, path in ipairs(extraKeys or {}) do
		put(values, path, lookup(out, path))
	end
	local block = { damage = statblock.damageOf(out, target), values = values }
	if withSkillDps and type(out.SkillDPS) == "table" then
		local rows = json.array()
		for _, row in ipairs(out.SkillDPS) do
			table.insert(rows, {
				name = tostring(row.name), dps = row.dps, count = row.count,
				skillPart = row.skillPart and tostring(row.skillPart) or nil,
				trigger = row.trigger and tostring(row.trigger) or nil,
				source = row.source and tostring(row.source) or nil,
			})
		end
		block.skillDps = rows
	end
	return block
end

return statblock
