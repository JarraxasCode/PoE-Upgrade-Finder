-- Damage targets (PLAN.md, Engine, "Damage target"; V10).
-- A request's target is one of:
--   nil or { kind = "saved" }                              the build as saved: Full DPS when any enabled
--                                                          group has "Include in Full DPS", else the main skill
--   { kind = "fullDps" }                                   Full DPS (needs a ticked group)
--   { kind = "skill", group = g, activeSkill = a, part = p }  one skill; part is optional (1-based, as in PoB)
-- A one-skill target is applied in memory only: build.mainSocketGroup, the group's mainActiveSkill and the
-- gem's skillPart, plus viewMode moved off "TREE" (TREE view forces the Full DPS roll-up). Everything is
-- restored after the call, so the saved build is never changed. Nothing is ever force-ticked into Full DPS.

local json = engineRequire("json")

local target = {}

local function fail(code, message)
	error({ code = code, message = message }, 0)
end

local function groupName(group)
	if group.displayLabel and group.displayLabel ~= "" then
		return group.displayLabel
	end
	if group.label and group.label ~= "" then
		return group.label
	end
	local first = group.gemList and group.gemList[1]
	return first and first.nameSpec or "?"
end

local function hasFullDpsGroup()
	for _, group in ipairs(build.skillsTab.socketGroupList) do
		if group.includeInFullDPS and group.enabled ~= false then
			return true
		end
	end
	return false
end

-- The socket groups and their active skills, for the Search view's target picker.
function target.listSkills()
	local groups = json.array()
	for gi, group in ipairs(build.skillsTab.socketGroupList) do
		local skills = json.array()
		for ai, activeSkill in ipairs(group.displaySkillList or {}) do
			local effect = activeSkill.activeEffect
			local parts = json.array()
			for _, p in ipairs(effect.grantedEffect.parts or {}) do
				table.insert(parts, tostring(p.name))
			end
			local minion = activeSkill.minion and activeSkill.minion.minionData and activeSkill.minion.minionData.name or nil
			table.insert(skills, {
				index = ai, name = effect.grantedEffect.name, minion = minion, parts = parts,
				skillPart = effect.srcInstance and effect.srcInstance.skillPart or nil,
			})
		end
		table.insert(groups, {
			index = gi, name = groupName(group), enabled = group.enabled ~= false, slot = group.slot,
			includeInFullDPS = group.includeInFullDPS == true, mainActiveSkill = group.mainActiveSkill, activeSkills = skills,
		})
	end
	return groups
end

-- Checks a request's target and returns a resolved one: { kind = "fullDps" } or
-- { kind = "skill", group, activeSkill, part, name }, plus saved = true when it came from the save.
function target.resolve(requested)
	if requested ~= nil and type(requested) ~= "table" then
		fail("bad-target", "target must be an object")
	end
	local kind = requested and requested.kind or "saved"
	if kind == "saved" then
		if hasFullDpsGroup() then
			return { kind = "fullDps", saved = true }
		end
		local gi = build.mainSocketGroup
		local group = build.skillsTab.socketGroupList[gi]
		if not group then
			fail("bad-target", "the build has no main socket group")
		end
		local resolved = target.resolve({ kind = "skill", group = gi, activeSkill = group.mainActiveSkill or 1 })
		resolved.saved = true
		return resolved
	elseif kind == "fullDps" then
		if not hasFullDpsGroup() then
			fail("bad-target", "no enabled socket group has Include in Full DPS ticked")
		end
		return { kind = "fullDps", saved = false }
	elseif kind == "skill" then
		local gi, ai, part = requested.group, requested.activeSkill, requested.part
		local group = type(gi) == "number" and build.skillsTab.socketGroupList[gi]
		if not group then
			fail("bad-target", "no socket group " .. tostring(gi))
		end
		local activeSkill = type(ai) == "number" and group.displaySkillList and group.displaySkillList[ai]
		if not activeSkill then
			fail("bad-target", "socket group " .. gi .. " has no active skill " .. tostring(ai))
		end
		local parts = activeSkill.activeEffect.grantedEffect.parts
		if part ~= nil and (type(part) ~= "number" or not parts or not parts[part]) then
			fail("bad-target", "skill " .. activeSkill.activeEffect.grantedEffect.name .. " has no part " .. tostring(part))
		end
		return { kind = "skill", group = gi, activeSkill = ai, part = part, name = activeSkill.activeEffect.grantedEffect.name, saved = false }
	end
	fail("bad-target", "unknown target kind " .. tostring(kind))
end

-- Runs fn(useFullDps) with the target applied in memory, then restores the build, even on error.
function target.with(resolved, fn)
	if resolved.kind == "fullDps" then
		return fn(true)
	end
	local group = build.skillsTab.socketGroupList[resolved.group]
	local src = group.displaySkillList[resolved.activeSkill].activeEffect.srcInstance
	local saved = {
		mainSocketGroup = build.mainSocketGroup,
		mainActiveSkill = group.mainActiveSkill,
		viewMode = build.viewMode,
		skillPart = src and src.skillPart,
		skillPartCalcs = src and src.skillPartCalcs,
	}
	build.mainSocketGroup = resolved.group
	group.mainActiveSkill = resolved.activeSkill
	if build.viewMode == "TREE" then
		build.viewMode = "ITEMS"
	end
	if src and resolved.part then
		src.skillPart = resolved.part
	end
	local results = { pcall(fn, false) }
	build.mainSocketGroup = saved.mainSocketGroup
	group.mainActiveSkill = saved.mainActiveSkill
	build.viewMode = saved.viewMode
	if src then
		src.skillPart = saved.skillPart
		src.skillPartCalcs = saved.skillPartCalcs
	end
	if not results[1] then
		error(results[2], 0)
	end
	return unpack(results, 2, table.maxn(results))
end

-- The target as sent back to the client.
function target.describe(resolved)
	return { kind = resolved.kind, saved = resolved.saved, group = resolved.group, activeSkill = resolved.activeSkill, part = resolved.part, name = resolved.name }
end

-- Why PoB disabled the target's skill, or for Full DPS each included skill PoB disabled, as
-- "Ground Slam (Main Hand weapon is not usable with this skill)"; nil when none is. PoB sets
-- activeSkill.disableReason while it builds the skills (CalcActiveSkill.lua: the wrong weapon, no shield,
-- a mana reservation it needs) and shows the main skill's in its own sidebar (Build.lua:2114). The skills
-- are the socket groups' displaySkillList, from the last full build of the build as loaded (#36).
function target.disableReason(resolved)
	local reasons, seen = {}, {}
	local function add(activeSkill)
		local reason = activeSkill and activeSkill.disableReason
		if type(reason) == "string" and reason ~= "" then
			local text = activeSkill.activeEffect.grantedEffect.name .. " (" .. reason .. ")"
			if not seen[text] then
				seen[text] = true
				table.insert(reasons, text)
			end
		end
	end
	local groups = build.skillsTab.socketGroupList
	if resolved.kind == "skill" then
		local group = groups[resolved.group]
		add(group and group.displaySkillList and group.displaySkillList[resolved.activeSkill])
	else
		for _, group in ipairs(groups) do
			if group.includeInFullDPS and group.enabled ~= false then
				for _, activeSkill in ipairs(group.displaySkillList or {}) do
					add(activeSkill)
				end
			end
		end
	end
	if #reasons == 0 then
		return nil
	end
	return table.concat(reasons, "; ")
end

return target
