import React from "react";

import inflection from "inflection";
import _ from "underscore";
import { t } from "ttag";
import Utils from "metabase/lib/utils";
import Field from "metabase-lib/lib/metadata/Field";
import { getOperators } from "metabase/lib/schema_metadata";
import { createLookupByProperty } from "metabase/lib/table";
import { isFK, TYPE } from "metabase/lib/types";
import { stripId, formatField } from "metabase/lib/formatting";
import { format as formatExpression } from "metabase/lib/expressions/formatter";

import * as Table from "./query/table";

import * as Q from "./query/query";
import * as F from "./query/field";

export const NEW_QUERY_TEMPLATES = {
  query: {
    database: null,
    type: "query",
    query: {
      "source-table": null,
    },
  },
  native: {
    database: null,
    type: "native",
    native: {
      query: "",
    },
  },
};

export function createQuery(type = "query", databaseId, tableId) {
  const dataset_query = Utils.copy(NEW_QUERY_TEMPLATES[type]);

  if (databaseId) {
    dataset_query.database = databaseId;
  }

  if (type === "query" && databaseId && tableId) {
    dataset_query.query["source-table"] = tableId;
  }

  return dataset_query;
}

const METRIC_NAME_BY_AGGREGATION = {
  count: "count",
  "cum-count": "count",
  sum: "sum",
  "cum-sum": "sum",
  distinct: "count",
  avg: "avg",
  min: "min",
  max: "max",
};

const METRIC_TYPE_BY_AGGREGATION = {
  count: TYPE.Integer,
  "cum-count": TYPE.Integer,
  sum: TYPE.Float,
  "cum-sum": TYPE.Float,
  distinct: TYPE.Integer,
  avg: TYPE.Float,
  min: TYPE.Float,
  max: TYPE.Float,
};

const SORTABLE_AGGREGATION_TYPES = new Set([
  "avg",
  "count",
  "distinct",
  "stddev",
  "sum",
  "min",
  "max",
]);

const Query = {
  isStructured(dataset_query) {
    return dataset_query && dataset_query.type === "query";
  },

  isNative(dataset_query) {
    return dataset_query && dataset_query.type === "native";
  },

  canRun(query, tableMetadata) {
    if (
      !query ||
      query["source-table"] == null ||
      !Query.hasValidAggregation(query)
    ) {
      return false;
    }
    // check that the table supports this aggregation, if we have tableMetadata
    if (tableMetadata) {
      const aggs = Query.getAggregations(query);
      if (aggs.length === 0) {
        if (
          !_.findWhere(tableMetadata.aggregation_options, { short: "rows" })
        ) {
          return false;
        }
      } else {
        for (const [agg] of aggs) {
          if (
            agg !== "metric" &&
            !_.findWhere(tableMetadata.aggregation_options, { short: agg })
          ) {
            // return false;
          }
        }
      }
    }
    return true;
  },

  cleanQuery(query) {
    if (!query) {
      return query;
    }

    // it's possible the user left some half-done parts of the query on screen when they hit the run button, so find those
    // things now and clear them out so that we have a nice clean set of valid clauses in our query

    // aggregations
    query.aggregation = Query.getAggregations(query);
    if (query.aggregation.length === 0) {
      delete query.aggregation;
    }

    // breakouts
    query.breakout = Query.getBreakouts(query);
    if (query.breakout.length === 0) {
      delete query.breakout;
    }

    // filters
    const filters = Query.getFilters(query).filter(filter =>
      _.all(filter, a => a != null),
    );
    if (filters.length > 0) {
      query.filter = ["and", ...filters];
    } else {
      delete query.filter;
    }

    if (query["order-by"]) {
      query["order-by"] = query["order-by"]
        .map(s => {
          const [direction, field] = s;

          // remove incomplete sorts
          if (!Query.isValidField(field) || direction == null) {
            return null;
          }

          if (Query.isAggregateField(field)) {
            // remove aggregation sort if we can't sort by this aggregation
            if (Query.canSortByAggregateField(query, field[1])) {
              return s;
            }
          } else if (Query.hasValidBreakout(query)) {
            const exactMatches = query.breakout.filter(b =>
              Query.isSameField(b, field, true),
            );
            if (exactMatches.length > 0) {
              return s;
            }
            const targetMatches = query.breakout.filter(b =>
              Query.isSameField(b, field, false),
            );
            if (targetMatches.length > 0) {
              // query processor expect the order-by clause to match the breakout's datetime-field unit or fk-> target,
              // so just replace it with the one that matches the target field
              // NOTE: if we have more than one breakout for the same target field this could match the wrong one
              if (targetMatches.length > 1) {
                console.warn(
                  "Sort clause matches more than one breakout field",
                  field,
                  targetMatches,
                );
              }
              return [direction, targetMatches[0]];
            }
          } else if (Query.isBareRows(query)) {
            return s;
          }

          // otherwise remove sort if it doesn't have a breakout but isn't a bare rows aggregation
          return null;
        })
        .filter(s => s != null);

      if (query["order-by"].length === 0) {
        delete query["order-by"];
      }
    }

    if (typeof query.limit !== "number") {
      delete query.limit;
    }

    if (query.expressions) {
      delete query.expressions[""];
    } // delete any empty expressions

    return query;
  },

  canAddDimensions(query) {
    const MAX_DIMENSIONS = 2;
    return query && query.breakout && query.breakout.length < MAX_DIMENSIONS;
  },

  numDimensions(query) {
    if (query && query.breakout) {
      return query.breakout.filter(function(b) {
        return b !== null;
      }).length;
    }

    return 0;
  },

  hasValidBreakout(query) {
    return (
      query &&
      query.breakout &&
      query.breakout.length > 0 &&
      query.breakout[0] !== null
    );
  },

  canSortByAggregateField(query, index) {
    if (!Query.hasValidBreakout(query)) {
      return false;
    }
    const aggregations = Query.getAggregations(query);
    return (
      aggregations[index] &&
      aggregations[index][0] &&
      SORTABLE_AGGREGATION_TYPES.has(aggregations[index][0])
    );
  },

  isSegmentFilter(filter) {
    return Array.isArray(filter) && filter[0] === "segment";
  },

  canAddLimitAndSort(query) {
    if (Query.isBareRows(query)) {
      return true;
    } else if (Query.hasValidBreakout(query)) {
      return true;
    } else {
      return false;
    }
  },

  getSortableFields(query, fields) {
    // in bare rows all fields are sortable, otherwise we only sort by our breakout columns
    if (Query.isBareRows(query)) {
      return fields;
    } else if (Query.hasValidBreakout(query)) {
      // further filter field list down to only fields in our breakout clause
      const breakoutFieldList = [];

      const breakouts = Query.getBreakouts(query);
      breakouts.map(function(breakoutField) {
        const fieldId = Query.getFieldTargetId(breakoutField);
        const field = _.findWhere(fields, { id: fieldId });
        if (field) {
          breakoutFieldList.push(field);
        }
      });

      const aggregations = Query.getAggregations(query);
      for (const [index, aggregation] of aggregations.entries()) {
        if (Query.canSortByAggregateField(query, index)) {
          breakoutFieldList.push({
            id: ["aggregation", index],
            name: aggregation[0], // e.g. "sum"
            display_name: aggregation[0],
          });
        }
      }

      return breakoutFieldList;
    } else {
      return [];
    }
  },

  canAddSort(query) {
    // TODO: allow for multiple sorting choices
    return false;
  },

  getExpressions(query) {
    return query.expressions || {};
  },

  setExpression(query, name, expression) {
    if (name && expression) {
      const expressions = query.expressions || {};
      expressions[name] = expression;
      query.expressions = expressions;
    }

    return query;
  },

  // remove an expression with NAME. Returns scrubbed QUERY with all references to expression removed.
  removeExpression(query, name) {
    if (!query.expressions) {
      return query;
    }

    delete query.expressions[name];

    if (_.isEmpty(query.expressions)) {
      delete query.expressions;
    }

    // ok, now "scrub" the query to remove any references to the expression
    function isExpressionReference(obj) {
      return (
        obj &&
        obj.constructor === Array &&
        obj.length === 2 &&
        obj[0] === "expression" &&
        obj[1] === name
      );
    }

    function removeExpressionReferences(obj) {
      return isExpressionReference(obj)
        ? null
        : obj.constructor === Array
        ? _.map(obj, removeExpressionReferences)
        : typeof obj === "object"
        ? _.mapObject(obj, removeExpressionReferences)
        : obj;
    }

    return this.cleanQuery(removeExpressionReferences(query));
  },

  // DEPRECATED
  isRegularField(field) {
    return typeof field === "number";
  },

  isLocalField(field) {
    return Array.isArray(field) && field[0] === "field-id";
  },

  isForeignKeyField(field) {
    return Array.isArray(field) && field[0] === "fk->";
  },

  isDatetimeField(field) {
    return Array.isArray(field) && field[0] === "datetime-field";
  },

  isBinningStrategy: F.isBinningStrategy,

  isExpressionField(field) {
    return (
      Array.isArray(field) && field.length === 2 && field[0] === "expression"
    );
  },

  isAggregateField(field) {
    return Array.isArray(field) && field[0] === "aggregation";
  },

  // field literal has the formal ["field-literal", <field-name>, <field-base-type>]
  isFieldLiteral(field) {
    return (
      Array.isArray(field) &&
      field.length === 3 &&
      field[0] === "field-literal" &&
      _.isString(field[1]) &&
      _.isString(field[2])
    );
  },

  isValidField(field) {
    return (
      Query.isRegularField(field) ||
      Query.isLocalField(field) ||
      (Query.isForeignKeyField(field) &&
        (Query.isLocalField(field[1]) || Query.isRegularField(field[1])) &&
        (Query.isLocalField(field[2]) || Query.isRegularField(field[2]))) ||
      // datetime field can  be either 4-item (deprecated): ["datetime-field", <field>, "as", <unit>]
      // or 3 item (preferred style): ["datetime-field", <field>, <unit>]
      (Query.isDatetimeField(field) &&
        Query.isValidField(field[1]) &&
        (field.length === 4
          ? field[2] === "as" && typeof field[3] === "string" // deprecated
          : typeof field[2] === "string")) ||
      (Query.isExpressionField(field) && _.isString(field[1])) ||
      (Query.isAggregateField(field) && typeof field[1] === "number") ||
      Query.isFieldLiteral(field)
    );
  },

  isSameField: function(fieldA, fieldB, exact = false) {
    if (exact) {
      return _.isEqual(fieldA, fieldB);
    } else {
      return Query.getFieldTargetId(fieldA) === Query.getFieldTargetId(fieldB);
    }
  },

  // gets the target field ID (recursively) from any type of field, including raw field ID, fk->, and datetime-field cast.
  getFieldTargetId: function(field) {
    if (Query.isRegularField(field)) {
      return field;
    } else if (Query.isLocalField(field)) {
      return field[1];
    } else if (Query.isForeignKeyField(field)) {
      return Query.getFieldTargetId(field[2]);
    } else if (Query.isDatetimeField(field)) {
      return Query.getFieldTargetId(field[1]);
    } else if (Query.isBinningStrategy(field)) {
      return Query.getFieldTargetId(field[1]);
    } else if (Query.isExpressionField(field)) {
      return field;
    } else if (Query.isFieldLiteral(field)) {
      return field;
    }
    console.warn("Unknown field type: ", field);
  },

  // gets the table and field definitions from from a raw, fk->, or datetime-field field
  getFieldTarget: function(field, tableDef, path = []) {
    if (Query.isRegularField(field)) {
      return { table: tableDef, field: Table.getField(tableDef, field), path };
    } else if (Query.isLocalField(field)) {
      return Query.getFieldTarget(field[1], tableDef, path);
    } else if (Query.isForeignKeyField(field)) {
      const fkFieldId = Query.getFieldTargetId(field[1]);
      const fkFieldDef = Table.getField(tableDef, fkFieldId);
      const targetTableDef = fkFieldDef && fkFieldDef.target.table;
      return Query.getFieldTarget(
        field[2],
        targetTableDef,
        path.concat(fkFieldDef),
      );
    } else if (Query.isDatetimeField(field)) {
      return {
        ...Query.getFieldTarget(field[1], tableDef, path),
        unit: Query.getDatetimeUnit(field),
      };
    } else if (Query.isBinningStrategy(field)) {
      return Query.getFieldTarget(field[1], tableDef, path);
    } else if (Query.isExpressionField(field)) {
      // hmmm, since this is a dynamic field we'll need to build this here
      // but base it on Field object, since some functions are used, when adding as filter
      const fieldDef = new Field({
        display_name: field[1],
        name: field[1],
        expression_name: field[1],
        metadata: tableDef.metadata,
        // TODO: we need to do something better here because filtering depends on knowing a sensible type for the field
        base_type: TYPE.Float,
        operators_lookup: {},
        operators: [],
        active: true,
        fk_target_field_id: null,
        parent_id: null,
        preview_display: true,
        special_type: null,
        target: null,
        visibility_type: "normal",
      });
      fieldDef.operators = getOperators(fieldDef, tableDef);
      fieldDef.operators_lookup = createLookupByProperty(
        fieldDef.operators,
        "name",
      );

      return {
        table: tableDef,
        field: fieldDef,
        path: path,
      };
    } else if (Query.isFieldLiteral(field)) {
      return { table: tableDef, field: Table.getField(tableDef, field), path }; // just pretend it's a normal field
    }

    console.warn("Unknown field type: ", field);
  },

  getFieldPath(fieldId, tableDef) {
    const path = [];
    while (fieldId != null) {
      const field = Table.getField(tableDef, fieldId);
      path.unshift(field);
      fieldId = field && field.parent_id;
    }
    return path;
  },

  getFieldPathName(fieldId, tableDef) {
    return Query.getFieldPath(fieldId, tableDef)
      .map(formatField)
      .join(": ");
  },

  getDatetimeUnit(field) {
    if (field.length === 4) {
      return field[3]; // deprecated
    } else {
      return field[2];
    }
  },

  getFieldOptions(
    fields,
    includeJoins = false,
    filterFn = _.identity,
    usedFields = {},
  ) {
    const results = {
      count: 0,
      fields: null,
      fks: [],
    };
    // filter based on filterFn, then remove fks if they'll be duplicated in the joins fields
    results.fields = filterFn(fields).filter(
      f => !usedFields[f.id] && (!isFK(f.special_type) || !includeJoins),
    );
    results.count += results.fields.length;
    if (includeJoins) {
      results.fks = fields
        .filter(f => isFK(f.special_type) && f.target)
        .map(joinField => {
          const targetFields = filterFn(joinField.target.table.fields).filter(
            f =>
              (!Array.isArray(f.id) || f.id[0] !== "aggregation") &&
              !usedFields[f.id],
          );
          results.count += targetFields.length;
          return {
            field: joinField,
            fields: targetFields,
          };
        })
        .filter(r => r.fields.length > 0);
    }

    return results;
  },

  formatField(fieldDef, options = {}) {
    const name = stripId(fieldDef && (fieldDef.display_name || fieldDef.name));
    return name;
  },

  getFieldName(tableMetadata, field, options) {
    try {
      const target = Query.getFieldTarget(field, tableMetadata);
      const components = [];
      if (target.path) {
        for (const fieldDef of target.path) {
          components.push(Query.formatField(fieldDef, options), " → ");
        }
      }
      components.push(Query.formatField(target.field, options));
      if (target.unit) {
        components.push(` (${target.unit})`);
      }
      return components;
    } catch (e) {
      console.warn(
        "Couldn't format field name for field",
        field,
        "in table",
        tableMetadata,
      );
    }
    return "[Unknown Field]";
  },

  getTableDescription(tableMetadata) {
    return [inflection.pluralize(tableMetadata.display_name)];
  },

  getAggregationDescription(tableMetadata, query, options) {
    return conjunctList(
      Query.getAggregations(query).map(aggregation => {
        if (NamedClause.isNamed(aggregation)) {
          return [NamedClause.getName(aggregation)];
        }
        if (AggregationClause.isMetric(aggregation)) {
          const metric = _.findWhere(tableMetadata.metrics, {
            id: AggregationClause.getMetric(aggregation),
          });
          const name = metric ? metric.name : "[Unknown Metric]";
          return [
            options.jsx ? (
              <span className="text-green text-bold">{name}</span>
            ) : (
              name
            ),
          ];
        }
        switch (aggregation[0]) {
          case "rows":
            return [t`Raw data`];
          case "count":
            return [t`Count`];
          case "cum-count":
            return [t`Cumulative count`];
          case "avg":
            return [
              t`Average of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "distinct":
            return [
              t`Distinct values of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "stddev":
            return [
              t`Standard deviation of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "sum":
            return [
              t`Sum of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "cum-sum":
            return [
              t`Cumulative sum of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "max":
            return [
              t`Maximum of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          case "min":
            return [
              t`Minimum of `,
              Query.getFieldName(tableMetadata, aggregation[1], options),
            ];
          default:
            return [formatExpression(aggregation, { tableMetadata })];
        }
      }),
      "and",
    );
  },

  getBreakoutDescription(tableMetadata, { breakout }, options) {
    if (breakout && breakout.length > 0) {
      return [
        t`Grouped by `,
        joinList(
          breakout.map(b => Query.getFieldName(tableMetadata, b, options)),
          " and ",
        ),
      ];
    }
  },

  getFilterDescription(tableMetadata, query, options) {
    // getFilters returns list of filters without the implied "and"
    const filters = ["and"].concat(Query.getFilters(query));
    if (filters && filters.length > 1) {
      return [
        t`Filtered by `,
        Query.getFilterClauseDescription(tableMetadata, filters, options),
      ];
    }
  },

  getFilterClauseDescription(tableMetadata, filter, options) {
    if (filter[0] === "and" || filter[0] === "or") {
      const clauses = filter
        .slice(1)
        .map(f => Query.getFilterClauseDescription(tableMetadata, f, options));
      return conjunctList(clauses, filter[0].toLowerCase());
    } else if (filter[0] === "segment") {
      const segment = _.findWhere(tableMetadata.segments, { id: filter[1] });
      const name = segment ? segment.name : "[Unknown Segment]";
      return options.jsx ? (
        <span className="text-purple text-bold">{name}</span>
      ) : (
        name
      );
    } else {
      return Query.getFieldName(tableMetadata, filter[1], options);
    }
  },

  getOrderByDescription(tableMetadata, query, options) {
    const orderBy = query["order-by"];
    if (orderBy && orderBy.length > 0) {
      return [
        t`Sorted by `,
        joinList(
          orderBy.map(
            ([direction, field]) =>
              Query.getFieldName(tableMetadata, field, options) +
              " " +
              (direction === "asc" ? "ascending" : "descending"),
          ),
          " and ",
        ),
      ];
    }
  },

  getLimitDescription(tableMetadata, { limit }) {
    if (limit != null) {
      return [limit, " ", inflection.inflect("row", limit)];
    }
  },

  generateQueryDescription(tableMetadata, query, options = {}) {
    if (!tableMetadata) {
      return "";
    }

    options = {
      jsx: false,
      sections: [
        "table",
        "aggregation",
        "breakout",
        "filter",
        "order-by",
        "limit",
      ],
      ...options,
    };

    const sectionFns = {
      table: Query.getTableDescription,
      aggregation: Query.getAggregationDescription,
      breakout: Query.getBreakoutDescription,
      filter: Query.getFilterDescription,
      "order-by": Query.getOrderByDescription,
      limit: Query.getLimitDescription,
    };

    // these array gymnastics are needed to support JSX formatting
    const sections = options.sections
      .map(section =>
        _.flatten(sectionFns[section](tableMetadata, query, options)).filter(
          s => !!s,
        ),
      )
      .filter(s => s && s.length > 0);

    const description = _.flatten(joinList(sections, ", "));
    if (options.jsx) {
      return <span>{description}</span>;
    } else {
      return description.join("");
    }
  },

  getDatetimeFieldUnit(field) {
    return field && field[3];
  },

  getAggregationType(aggregation) {
    return aggregation && aggregation[0];
  },

  getAggregationField(aggregation) {
    return aggregation && aggregation[1];
  },

  getQueryColumn(tableMetadata, field) {
    const target = Query.getFieldTarget(field, tableMetadata);
    const column = { ...target.field };
    if (Query.isDatetimeField(field)) {
      column.unit = Query.getDatetimeFieldUnit(field);
    }
    return column;
  },

  getQueryColumns(tableMetadata, query) {
    const columns = Query.getBreakouts(query).map(b =>
      Query.getQueryColumn(tableMetadata, b),
    );
    if (Query.isBareRows(query)) {
      if (columns.length === 0) {
        return null;
      }
    } else {
      for (const aggregation of Query.getAggregations(query)) {
        const type = Query.getAggregationType(aggregation);
        columns.push({
          name: METRIC_NAME_BY_AGGREGATION[type],
          base_type: METRIC_TYPE_BY_AGGREGATION[type],
          special_type: TYPE.Number,
        });
      }
    }
    return columns;
  },
};

for (const prop in Q) {
  // eslint-disable-next-line import/namespace
  Query[prop] = Q[prop];
}

import { isMath } from "metabase/lib/expressions";

export const NamedClause = {
  hasOptions(clause) {
    return Array.isArray(clause) && clause[0] === "aggregation-options";
  },
  getOptions(clause) {
    return NamedClause.hasOptions(clause) ? clause[2] : {};
  },
  isNamed(clause) {
    return NamedClause.getOptions(clause)["display-name"];
  },
  getName(clause) {
    return NamedClause.getOptions(clause)["display-name"];
  },
  getContent(clause) {
    return NamedClause.hasOptions(clause) ? clause[1] : clause;
  },
  setName(clause, name) {
    return [
      "aggregation-options",
      NamedClause.getContent(clause),
      { "display-name": name, ...NamedClause.getOptions(clause) },
    ];
  },
  setContent(clause, content) {
    return ["aggregation-options", content, NamedClause.getOptions(clause)];
  },
};

export const AggregationClause = {
  // predicate function to test if a given aggregation clause is fully formed
  isValid(aggregation) {
    if (
      aggregation &&
      _.isArray(aggregation) &&
      ((aggregation.length === 1 && aggregation[0] !== null) ||
        (aggregation.length === 2 &&
          aggregation[0] !== null &&
          aggregation[1] !== null))
    ) {
      return true;
    }
    return false;
  },

  // predicate function to test if the given aggregation clause represents a Bare Rows aggregation
  isBareRows(aggregation) {
    return AggregationClause.isValid(aggregation) && aggregation[0] === "rows";
  },

  // predicate function to test if a given aggregation clause represents a standard aggregation
  isStandard(aggregation) {
    return (
      AggregationClause.isValid(aggregation) && aggregation[0] !== "metric"
    );
  },

  getAggregation(aggregation) {
    return aggregation && aggregation[0];
  },

  // predicate function to test if a given aggregation clause represents a metric
  isMetric(aggregation) {
    return (
      AggregationClause.isValid(aggregation) && aggregation[0] === "metric"
    );
  },

  // get the metricId from a metric aggregation clause
  getMetric(aggregation) {
    if (aggregation && AggregationClause.isMetric(aggregation)) {
      return aggregation[1];
    } else {
      return null;
    }
  },

  isCustom(aggregation) {
    // for now treal all named clauses as custom
    return (
      (aggregation && NamedClause.isNamed(aggregation)) ||
      isMath(aggregation) ||
      (AggregationClause.isStandard(aggregation) &&
        _.any(aggregation.slice(1), arg => isMath(arg)))
    );
  },

  // get the operator from a standard aggregation clause
  getOperator(aggregation) {
    if (aggregation && aggregation.length > 0 && aggregation[0] !== "metric") {
      return aggregation[0];
    } else {
      return null;
    }
  },

  // get the fieldId from a standard aggregation clause
  getField(aggregation) {
    if (aggregation && aggregation.length > 1 && aggregation[0] !== "metric") {
      return aggregation[1];
    } else {
      return null;
    }
  },

  // set the fieldId on a standard aggregation clause
  setField(aggregation, fieldId) {
    if (
      aggregation &&
      aggregation.length > 0 &&
      aggregation[0] &&
      aggregation[0] !== "metric"
    ) {
      return [aggregation[0], fieldId];
    } else {
      // TODO: is there a better failure response than just returning the aggregation unmodified??
      return aggregation;
    }
  },
};

export const BreakoutClause = {
  setBreakout(breakout, index, value) {
    if (!breakout) {
      breakout = [];
    }
    return [...breakout.slice(0, index), value, ...breakout.slice(index + 1)];
  },

  removeBreakout(breakout, index) {
    if (!breakout) {
      breakout = [];
    }
    return [...breakout.slice(0, index), ...breakout.slice(index + 1)];
  },
};

function joinList(list, joiner) {
  return _.flatten(
    list.map((l, i) => (i === list.length - 1 ? [l] : [l, joiner])),
    true,
  );
}

function conjunctList(list, conjunction) {
  switch (list.length) {
    case 0:
      return null;
    case 1:
      return list[0];
    case 2:
      return [list[0], " ", conjunction, " ", list[1]];
    default:
      return [
        list.slice(0, -1).join(", "),
        ", ",
        conjunction,
        " ",
        list[list.length - 1],
      ];
  }
}

export default Query;
