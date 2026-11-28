-- Changes to the loaded build that last for one call, each undone afterwards even on error, like target.with
-- (issue #48). Everything here works on PoB's live build object; nothing is ever saved.
--
--   buildedit.withCalcHook(useFullDps, onCalc, fn)  PoB's misc calculator, wrapped for the length of fn
--   buildedit.equip(slotName, item)                 puts an item (or nothing) in a slot and rebuilds; it stays
--   buildedit.unequip(token)                        undoes one equip and rebuilds
--   buildedit.withSlotItem(slotName, item, fn)      equip, fn, unequip
--   buildedit.tainted()                             why the build can't be trusted (an undo failed), or nil
--   buildedit.clearTaint()                          a fresh build was loaded
--
-- equip and withSlotItem rebuild the build (a full recalc, about 55 ms on RF), because PoB's misc calculator
-- starts from the build as it was last built. Call withSlotItem outside target.with: a rebuild re-reads the
-- socket groups, and target.with's in-memory switch must sit on top of the rebuilt build, not under it.
--
-- A rebuild runs PoB's OnFrame, whose errors Launch.lua catches and leaves in launch.promptMsg (it raises
-- nothing), so rebuild() clears promptMsg first and raises PoB's message when one is left (#109). When putting
-- a slot back fails, the build may keep the stand-in item. It is then marked tainted, and the dispatcher
-- refuses the build (stale-build) until the next loadBuild, so the client loads it again (#39).

local buildedit = {}

-- Why the loaded build can't be trusted any more, or nil.
local taint = nil

-- PoB's prompt text without colour codes (^1, ^x00FF00) or its "Press Enter/Escape..." key hints.
function buildedit.pobMessage(text)
	local lines = {}
	for line in (StripEscapes(tostring(text)) .. "\n"):gmatch("(.-)\r?\n") do
		if line ~= "" and not line:match("^Press ") then
			table.insert(lines, line)
		end
	end
	return table.concat(lines, "\n")
end

-- Rebuilds the build as PoB's GUI does on its next frame. Launch.lua's OnFrame PCalls PoB's own and only
-- stores an error in launch.promptMsg (ShowErrMsg, which keeps the first message), so promptMsg is cleared
-- before and an error left in it is raised.
local function rebuild()
	launch.promptMsg = nil
	build.buildFlag = true
	runCallback("OnFrame")
	local message = launch.promptMsg
	if message then
		launch.promptMsg = nil
		-- ShowErrMsg's text is "Error:", "In 'OnFrame': <error>", then PoB's version: keep the error.
		local text = buildedit.pobMessage(message)
		text = text:gsub("^Error:\n", ""):gsub("\nv[%d%.]+[^\n]*$", ""):gsub("^In 'OnFrame': ", "")
		error({ code = "internal", message = "PoB's rebuild failed: " .. text }, 0)
	end
end

local function errorMessage(e)
	if type(e) == "table" then
		return tostring(e.message or e.code)
	end
	return tostring(e)
end

-- Undoes an equip under pcall. first is { err } when something already failed, else nil. Returns the error
-- to raise, or nil: the first error when the undo worked; when it didn't, an error carrying both messages
-- (and the first error's code), with the build marked tainted.
local function restore(token, first)
	local ok, undoErr = pcall(buildedit.unequip, token)
	if ok then
		return first and (first[1] or "an error with no message")
	end
	taint = "putting " .. token.slotName .. " back failed: " .. errorMessage(undoErr)
	if not first then
		return { code = "internal", message = taint }
	end
	local code = type(first[1]) == "table" and first[1].code or "internal"
	return { code = code, message = errorMessage(first[1]) .. "; then " .. taint }
end

function buildedit.tainted()
	return taint
end

function buildedit.clearTaint()
	taint = nil
end

-- Runs fn() with build.calcsTab:GetMiscCalculator wrapped, so every calc made through it (by PoB's own code,
-- such as the trade query generator) first calls onCalc(). With useFullDps false the calc's flag is forced
-- off: PoB's callers pass no flag, which means "on", and the Full DPS roll-up only feeds FullDPS, FullDotDPS
-- and SkillDPS, which a one-skill target doesn't read. With useFullDps true the flag passes through as given.
-- The real GetMiscCalculator is put back afterwards, even on error.
--
-- The base output it returns is the build as it stands, calculated under the target (#109). PoB's own is
-- calcsTab.miscCalculator[2], from the last rebuild, so under the saved main skill: target.with switches the
-- main skill in memory without a rebuild (a rebuild would undo it). PoB's generator divides every ratio by
-- that base (WeightedRatioOutputs, capped at data.misc.maxStatIncrease), so for a picked skill the stored base
-- skewed the DPS weights, or zeroed them when the saved skill deals no damage. With useFullDps (a Full DPS
-- target, which target.with doesn't change) PoB's stored base is already the right one, and is kept: a fresh
-- Full DPS base would cost a roll-up per call.
function buildedit.withCalcHook(useFullDps, onCalc, fn)
	local calcsTab = build.calcsTab
	local realGetMisc = calcsTab.GetMiscCalculator
	calcsTab.GetMiscCalculator = function(tab)
		local func, base = realGetMisc(tab)
		local hooked = function(override, flag)
			onCalc()
			if useFullDps then
				return func(override, flag)
			end
			return func(override, false)
		end
		if not useFullDps then
			base = hooked({})
		end
		return hooked, base
	end
	local results = { pcall(fn) }
	calcsTab.GetMiscCalculator = realGetMisc
	if not results[1] then
		error(results[2], 0)
	end
	return unpack(results, 2, table.maxn(results))
end

-- Puts a parsed item (nil empties the slot) in a gear slot and rebuilds. The item joins the build's item
-- list as PoB's own "Equip" does, with no undo state. Returns a token for unequip. On its own the change
-- stays in the loaded build (for equipping a bought item, issue #61); withSlotItem undoes it. If the rebuild
-- fails (rebuild raises PoB's message), the slot is put back before the error is raised (see restore).
function buildedit.equip(slotName, item)
	local itemsTab = build.itemsTab
	local slot = itemsTab.slots[slotName]
	if not slot or slot.nodeId then
		error({ code = "bad-slot", message = "no item slot named " .. tostring(slotName) }, 0)
	end
	local token = { slotName = slotName, previousId = slot.selItemId or 0, added = nil }
	if item then
		item.id = nil
		itemsTab:AddItem(item, true)
		token.added = item
	end
	slot:SetSelItemId(item and item.id or 0)
	itemsTab:PopulateSlots()
	local ok, err = pcall(rebuild)
	if not ok then
		error(restore(token, { err }), 0)
	end
	return token
end

-- Undoes one equip: the slot gets its item back, the added item leaves the item list, and the build rebuilds.
function buildedit.unequip(token)
	local itemsTab = build.itemsTab
	itemsTab.slots[token.slotName]:SetSelItemId(token.previousId)
	if token.added then
		-- deferUndoState: no undo state, and no PopulateSlots (done below).
		itemsTab:DeleteItem(token.added, true)
	end
	itemsTab:PopulateSlots()
	rebuild()
end

-- Runs fn() with the item (or nothing) in the slot, then puts the slot back as it was, even on error.
function buildedit.withSlotItem(slotName, item, fn)
	local token = buildedit.equip(slotName, item)
	local results = { pcall(fn) }
	local err = restore(token, not results[1] and { results[2] } or nil)
	if err ~= nil then
		error(err, 0)
	end
	return unpack(results, 2, table.maxn(results))
end

return buildedit
