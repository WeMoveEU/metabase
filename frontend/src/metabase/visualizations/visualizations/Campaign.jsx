/* @flow */

import React, { Component } from "react";
import { t } from "ttag";
import _ from "underscore";

import colors from "metabase/lib/colors";
import { fieldSetting } from "metabase/visualizations/lib/settings/utils";
import { getComputedSettingsForSeries } from "metabase/visualizations/lib/settings/visualization";
import type { VisualizationProps } from "metabase/meta/types/Visualization";

import Gauge from "./Gauge.jsx";

export default class Campaign extends Component {
  props: VisualizationProps;

  static uiName = t`Campaign`;
  static identifier = "campaign";
  static iconName = "number";

  static minSize = { width: 3, height: 3 };

  static isSensible({cols, rows}) {
    return rows.length === 1 && cols.length >= 3;
  }

  static checkRenderable([{ data: { cols, rows } }]) {
    return cols.length >= 3;
  }

  static settings = {
    ...fieldSetting("campaign.name", {
      title: t`Name column`,
      getDefault: ([
        {
          data: { cols },
        },
      ]) => (_.find(cols, col => col.base_type == "type/Text") || cols[0]).name,
    }),
    ...fieldSetting("campaign.gauge", {
      title: t`Metric value`,
      getDefault: ([
        {
          data: { cols },
        },
      ]) => (_.find(cols, col => col.base_type == "type/Integer") || cols[0]).name,
    }),
    ...fieldSetting("campaign.goal", {
      title: t`Metric goal`,
      getDefault([ { data: { cols }, }, ], vizSettings) {
        const goalCol = _.find(cols,
          col => col.base_type == "type/Integer" && col.name != vizSettings["campaign.gauge"]
        );
        return (goalCol || cols[0]).name;
      },
      readDependencies: ["campaign.gauge"],
    }),
  };

  _getColumnIndex(cols: Column[], colName) {
    const columnIndex = _.findIndex(
      cols,
      col => col.name === colName,
    );
    return columnIndex < 0 ? 0 : columnIndex;
  }

  render() {
    const {
      series: [
        {
          data: { rows, cols },
        },
      ],
      settings,
      className,
    } = this.props;

    const row = rows[0];
    const nameIndex = this._getColumnIndex(cols, settings["campaign.name"]);
    const campaignName = row[nameIndex];

    const goalIndex = this._getColumnIndex(cols, settings["campaign.goal"]);
    const goal = row[goalIndex];
    const gaugeIndex = this._getColumnIndex(cols, settings["campaign.gauge"]);

    const gaugeSeries = this.props.series.map((s, seriesIndex) => ({
			card: {
				...s.card,
				display: "gauge",
				_seriesIndex: seriesIndex,
        visualization_settings: {
          "gauge.segments": [
            { min: 0, max: goal / 2, color: colors["error"], label: "" },
            { min: goal / 2, max: goal, color: colors["warning"], label: "" },
            { min: goal, max: goal * 2, color: colors["success"], label: "" },
          ],
        },
			},
			data: {
				cols: [
					{ ...s.data.cols[gaugeIndex] },
				],
				rows: [[s.data.rows[0][gaugeIndex]]],
			},
		}));

		const gaugeSettings = getComputedSettingsForSeries(gaugeSeries);

    return (
			<div className={className}>
        <h2>{campaignName}</h2>
        <Gauge
          series={gaugeSeries}
          settings={gaugeSettings}
          className={className} width={this.props.width} height={this.props.height}
          onHoverChange={this.props.onHoverChange}
        />
      </div>
		);
  }
}
