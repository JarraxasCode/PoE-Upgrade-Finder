-- JSON for the engine protocol.
-- Encoding is our own: dkjson writes numbers with tostring (14 significant digits), which is too few for
-- exact golden checks, and turns inf/NaN into null. Here numbers keep full precision (%.17g) and
-- non-finite numbers are sent as the strings "Infinity", "-Infinity" and "NaN" (PLAN.md, Engine, Protocol).
-- Decoding uses PoB's bundled dkjson.

local dkjson = require("dkjson")

local json = {}

local arrayMarker = {}

-- Marks a table so it encodes as a JSON array even when empty.
function json.array(t)
	return setmetatable(t or {}, arrayMarker)
end

local function encodeNumber(v)
	if v ~= v then
		return '"NaN"'
	elseif v == math.huge then
		return '"Infinity"'
	elseif v == -math.huge then
		return '"-Infinity"'
	elseif v == math.floor(v) and math.abs(v) < 1e15 then
		return string.format("%d", v)
	end
	return string.format("%.17g", v)
end

local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t", ["\b"] = "\\b", ["\f"] = "\\f" }

local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format("\\u%04x", c:byte())
	end) .. '"'
end

local function isArray(t)
	if getmetatable(t) == arrayMarker then
		return true
	end
	local n = 0
	for k in pairs(t) do
		if type(k) ~= "number" or k < 1 or k ~= math.floor(k) then
			return false
		end
		n = n + 1
	end
	return n > 0 and n == #t
end

local encodeValue

local function encodeTable(t, seen)
	if seen[t] then
		error("json: cycle in table")
	end
	seen[t] = true
	local parts = {}
	if isArray(t) then
		for i = 1, #t do
			parts[i] = encodeValue(t[i], seen)
		end
		seen[t] = nil
		return "[" .. table.concat(parts, ",") .. "]"
	end
	local keys = {}
	for k in pairs(t) do
		table.insert(keys, k)
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for _, k in ipairs(keys) do
		table.insert(parts, encodeString(tostring(k)) .. ":" .. encodeValue(t[k], seen))
	end
	seen[t] = nil
	return "{" .. table.concat(parts, ",") .. "}"
end

encodeValue = function(v, seen)
	local tv = type(v)
	if tv == "number" then
		return encodeNumber(v)
	elseif tv == "string" then
		return encodeString(v)
	elseif tv == "boolean" then
		return tostring(v)
	elseif tv == "nil" then
		return "null"
	elseif tv == "table" then
		return encodeTable(v, seen)
	end
	error("json: can't encode a " .. tv)
end

-- Encodes a value on one line (no newlines: the protocol is one message per line).
function json.encode(v)
	return encodeValue(v, {})
end

-- Decodes one message. Returns the value, or nil and an error message.
function json.decode(text)
	local value, _, err = dkjson.decode(text, 1, nil)
	if err then
		return nil, err
	end
	return value
end

return json
