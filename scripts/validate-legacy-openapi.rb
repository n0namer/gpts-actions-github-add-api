#!/usr/bin/env ruby
# frozen_string_literal: true
require "yaml"
require "date"
require "set"

path = ARGV[0] || "legacy-gpts-api-github-action.yaml"
source = File.read(path, encoding: "UTF-8")
issues = []

begin
  doc = YAML.safe_load(source, permitted_classes: [Date, Time], aliases: true)
rescue Psych::SyntaxError => e
  warn "YAML_PARSE_FAIL\t#{e.message}"
  exit 1
end

def add_issue(issues, code, path, detail)
  issues << [code, path, detail]
end

def walk(value, path, issues, &block)
  block.call(value, path, issues)
  case value
  when Hash
    value.each { |k, v| walk(v, "#{path}.#{k}", issues, &block) }
  when Array
    value.each_with_index { |v, i| walk(v, "#{path}[#{i}]", issues, &block) }
  end
end

unless doc.is_a?(Hash)
  add_issue(issues, "OPENAPI_ROOT", "$", "root must be a mapping")
  doc = {}
end

openapi = doc["openapi"]
add_issue(issues, "OPENAPI_VERSION", "$.openapi", openapi.inspect) unless openapi.to_s.start_with?("3.")
paths = doc["paths"]
unless paths.is_a?(Hash)
  add_issue(issues, "PATHS", "$.paths", "paths must be a mapping")
  paths = {}
end

# Detect duplicate top-level path keys before YAML last-write-wins hides them.
path_lines = Hash.new { |h, k| h[k] = [] }
source.each_line.with_index(1) do |line, no|
  if (m = line.match(/^  (\/[^:\n]+):\s*$/))
    path_lines[m[1]] << no
  end
end
path_lines.each do |key, lines|
  add_issue(issues, "DUPLICATE_PATH", "$.paths.#{key}", "lines #{lines.join(', ')}") if lines.length > 1
end

walk(doc, "$", issues) do |value, p, out|
  if value.is_a?(Date) || value.is_a?(Time)
    add_issue(out, "YAML_DATE_COERCION", p, "#{value.inspect} (#{value.class})")
  end
  next unless value.is_a?(Hash)

  type = value["type"]
  if value.key?("default")
    default = value["default"]
    case type
    when "string"
      add_issue(out, "STRING_DEFAULT_TYPE", "#{p}.default", "#{default.inspect} (#{default.class})") unless default.is_a?(String)
    when "integer"
      add_issue(out, "INTEGER_DEFAULT_TYPE", "#{p}.default", "#{default.inspect} (#{default.class})") unless default.is_a?(Integer)
    when "number"
      add_issue(out, "NUMBER_DEFAULT_TYPE", "#{p}.default", "#{default.inspect} (#{default.class})") unless default.is_a?(Numeric)
    when "boolean"
      add_issue(out, "BOOLEAN_DEFAULT_TYPE", "#{p}.default", "#{default.inspect} (#{default.class})") unless default == true || default == false
    end
  end

  description = value["description"]
  add_issue(out, "DESCRIPTION_TOO_LONG", "#{p}.description", description.length.to_s) if description.is_a?(String) && description.length > 300
end

http_methods = Set.new(%w[get put post delete options head patch trace])
seen_ops = {}
operation_count = 0

paths.each do |url, item|
  next unless item.is_a?(Hash)
  item.each do |method, op|
    next unless http_methods.include?(method.to_s.downcase) && op.is_a?(Hash)
    operation_count += 1
    oid = op["operationId"]
    if oid
      if seen_ops.key?(oid)
        add_issue(issues, "DUPLICATE_OPERATION_ID", oid, "#{seen_ops[oid]} vs #{method.to_s.upcase} #{url}")
      else
        seen_ops[oid] = "#{method.to_s.upcase} #{url}"
      end
      add_issue(issues, "FORBIDDEN_OPERATION_PREFIX", oid, "github_") if oid.start_with?("github_")
    end

    vars = url.scan(/\{([^}]+)\}/).flatten.to_set
    params = Array(op["parameters"]).select { |q| q.is_a?(Hash) && q["in"] == "path" }.to_h { |q| [q["name"], q] }
    vars.each do |var|
      q = params[var]
      if q.nil?
        add_issue(issues, "MISSING_PATH_PARAMETER", "$.paths.#{url}.#{method}", var)
      elsif q["required"] != true
        add_issue(issues, "PATH_PARAMETER_NOT_REQUIRED", "$.paths.#{url}.#{method}.parameters", var)
      end
    end
  end
end

puts "file=#{path}"
puts "operations=#{operation_count}"
puts "issues=#{issues.length}"
issues.each { |code, p, detail| puts [code, p, detail].join("\t") }
exit(issues.empty? ? 0 : 1)
