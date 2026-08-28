const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
});

// 清晰度优化：数值越高越清晰，但显卡负担也越大。
viewer.resolutionScale = 1.5;
viewer.scene.postProcessStages.fxaa.enabled = true;

const fileInput = document.getElementById("geojsonFile");
const clearButton = document.getElementById("clearButton");
const status = document.getElementById("status");

const now = Cesium.JulianDate.now();

const QGIS_COLORS = {
  road: Cesium.Color.fromCssColorString("#5B5D72"),
  sidewalk: Cesium.Color.fromCssColorString("#B9B6BA"),
  island: Cesium.Color.fromCssColorString("#898A94"),
  green: Cesium.Color.fromCssColorString("#326B6D"),
  facility: Cesium.Color.fromCssColorString("#D43E3E"),
  guardrail: Cesium.Color.fromCssColorString("#A87952"),
};

function getProperties(entity) {
  return entity.properties?.getValue(now) || {};
}

function getProperty(props, names, fallback = "") {
  for (const name of names) {
    if (props[name] !== undefined && props[name] !== null) {
      return props[name];
    }

    const key = Object.keys(props).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase()
    );

    if (key && props[key] !== undefined && props[key] !== null) {
      return props[key];
    }
  }

  return fallback;
}

function textOf(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasAny(value, words) {
  const text = textOf(value);
  return words.some((word) => text.includes(word.toLowerCase()));
}

function raisePosition(position, meters = 0.25) {
  const cartographic = Cesium.Cartographic.fromCartesian(position);
  return Cesium.Cartesian3.fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    cartographic.height + meters
  );
}

function raisePolyline(entity, meters = 0.25) {
  const positions = entity.polyline?.positions?.getValue(now);

  if (!positions || positions.length === 0) {
    return;
  }

  entity.polyline.positions = positions.map((position) => raisePosition(position, meters));
}

function stylePolygon(entity, color, height) {
  if (!entity.polygon) {
    return;
  }

  entity.polygon.material = color;
  entity.polygon.outline = false;
  entity.polygon.height = height;
}

function splitPolylineByMeters(positions, dashMeters, gapMeters) {
  const parts = [];
  let drawing = true;
  let remaining = dashMeters;
  let current = [];

  for (let i = 0; i < positions.length - 1; i += 1) {
    let start = positions[i];
    const end = positions[i + 1];
    let segmentLeft = Cesium.Cartesian3.distance(start, end);

    while (segmentLeft > 0.00001) {
      const step = Math.min(remaining, segmentLeft);
      const ratio = step / segmentLeft;
      const next = Cesium.Cartesian3.lerp(start, end, ratio, new Cesium.Cartesian3());

      if (drawing) {
        if (current.length === 0) current.push(start);
        current.push(next);
      }

      start = next;
      segmentLeft -= step;
      remaining -= step;

      if (remaining <= 0.00001) {
        if (drawing && current.length > 1) parts.push(current);
        current = [];
        drawing = !drawing;
        remaining = drawing ? dashMeters : gapMeters;
      }
    }
  }

  if (drawing && current.length > 1) parts.push(current);
  return parts;
}

function styleMarking(entity, props, typeText, markTypeText, dataSource) {
  if (!entity.polyline) {
    return;
  }

  const markText = `${markTypeText} ${typeText}`;
  const widthM = Number(
    getProperty(props, ["width_m", "宽度m", "width"], 0.15)
  ) || 0.15;

  const isZebra = hasAny(markText, ["斑马", "zebra"]);
  const isStop = hasAny(markText, ["停止", "stop"]);
  const isDashed = hasAny(markText, ["虚", "dashed", "待转", "1-1", "2-4", "4-6"]);
  const metricPattern = markText.includes("2-4")
    ? [2, 4]
    : markText.includes("4-6")
      ? [4, 6]
      : null;

  entity.polyline.clampToGround = false;
  const originalPositions = entity.polyline.positions?.getValue(now);
  if (!originalPositions || originalPositions.length < 2) return;
  const raisedPositions = originalPositions.map((position) => raisePosition(position, 0.25));

  entity.polyline.width = isZebra || isStop
    ? 6
    : Math.max(2, Math.min(5, widthM * 10));

  if (metricPattern) {
    entity.polyline.show = false;
    const parts = splitPolylineByMeters(raisedPositions, metricPattern[0], metricPattern[1]);
    parts.forEach((part) => dataSource.entities.add({
      polyline: {
        positions: part,
        width: entity.polyline.width,
        material: Cesium.Color.WHITE,
        clampToGround: false,
      },
    }));
    return;
  }

  entity.polyline.show = true;
  entity.polyline.positions = raisedPositions;
  entity.polyline.material = isDashed
    ? new Cesium.PolylineDashMaterialProperty({
        color: Cesium.Color.WHITE,
        dashLength: 16,
      })
    : Cesium.Color.WHITE;
}

function styleFacilityPoint(entity, typeText) {
  if (!entity.position) {
    return;
  }

  if (entity.billboard) {
    entity.billboard.show = false;
  }

  const currentPosition = entity.position.getValue(now);
  if (currentPosition) {
    const cartographic = Cesium.Cartographic.fromCartesian(currentPosition);
    entity.position = new Cesium.ConstantPositionProperty(
      Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        1.5
      )
    );
  }

  entity.point = new Cesium.PointGraphics({
    pixelSize: 14,
    color: QGIS_COLORS.facility,
    outlineColor: Cesium.Color.WHITE,
    outlineWidth: 2,
    heightReference: Cesium.HeightReference.NONE,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
}

function isFacilityEntity(entity, props, typeText, fileName) {
  if (!entity.position) {
    return false;
  }

  const name = fileName.toLowerCase();
  return name.includes("road_facility") ||
    String(getProperty(props, ["id"], "")).toUpperCase().startsWith("FAC-") ||
    hasAny(typeText, [
      "红绿灯", "信号灯", "摄像头", "摄像", "标牌", "标志", "路灯",
      "电子屏", "悬杆", "监控杆", "杆件", "traffic light", "camera", "sign", "pole",
    ]);
}

function styleEntity(entity, fileName, dataSource) {
  const props = getProperties(entity);
  const type = getProperty(props, ["type", "类型"], "");
  const markType = getProperty(props, ["mark_type", "标线类型"], "");
  const typeText = textOf(type);
  const markTypeText = textOf(markType);
  const name = fileName.toLowerCase();

  // 设施点优先识别，避免被通用图层逻辑漏掉。
  if (isFacilityEntity(entity, props, typeText, fileName)) {
    styleFacilityPoint(entity, typeText);
    return;
  }

  // 标线识别优先使用 mark_type/type，不依赖导出文件名。
  const isMarking = entity.polyline && (
    markTypeText !== "" ||
    hasAny(typeText, [
      "车道实线", "车道虚线", "停止线", "斑马线", "待转",
      "标线", "lane", "marking", "zebra", "stop line",
      "1-1", "2-4", "4-6",
    ]) ||
    name.includes("road_marking")
  );

  if (isMarking) {
    styleMarking(entity, props, typeText, markTypeText, dataSource);
    return;
  }

  if (entity.polygon && (
    hasAny(typeText, ["道路", "路面", "road surface", "road_surface"]) ||
    name.includes("road_surface")
  )) {
    stylePolygon(entity, QGIS_COLORS.road.withAlpha(1.0), 0);
    return;
  }

  if (entity.polygon && (
    hasAny(typeText, ["绿化", "green", "vegetation"]) ||
    name.includes("green")
  )) {
    stylePolygon(entity, QGIS_COLORS.green.withAlpha(1.0), 0.05);
    return;
  }

  if (entity.polygon && (
    hasAny(typeText, ["交通岛", "traffic island", "traffic_island"]) ||
    name.includes("traffic_island")
  )) {
    stylePolygon(entity, QGIS_COLORS.island.withAlpha(1.0), 0.02);
    return;
  }

  if (entity.polygon && (
    typeText === "人行道" || typeText === "sidewalk" || typeText === "pavement" ||
    name.includes("sidewalk")
  )) {
    stylePolygon(entity, QGIS_COLORS.sidewalk.withAlpha(1.0), 0.04);
    return;
  }

  if (entity.polygon && (
    hasAny(typeText, ["箭头", "导向", "arrow", "direction"]) ||
    name.includes("arrow")
  )) {
    stylePolygon(entity, Cesium.Color.WHITE, 0.06);
    return;
  }

  if (entity.polyline && hasAny(typeText, ["护栏", "guardrail", "guard rail"])) {
    entity.polyline.material = QGIS_COLORS.guardrail;
    entity.polyline.width = 4;
    entity.polyline.clampToGround = true;
    return;
  }

  // 道路中线只作为数据保留，不参与最终视觉显示。
  if (entity.polyline && (
    hasAny(typeText, ["道路中线", "centerline", "road centerline"]) ||
    (name.includes("roads") && !name.includes("road_marking"))
  )) {
    entity.polyline.show = false;
    return;
  }

  if (entity.polyline) {
    entity.polyline.material = Cesium.Color.GRAY;
    entity.polyline.width = 3;
    entity.polyline.clampToGround = true;
  }
}

async function loadGeoJsonFile(file) {
  const text = await file.text();
  const geojson = JSON.parse(text);
  const dataSource = await Cesium.GeoJsonDataSource.load(geojson, {
    clampToGround: !file.name.toLowerCase().includes("road_facility"),
  });

  const sourceEntities = dataSource.entities.values.slice();
  for (const entity of sourceEntities) {
    styleEntity(entity, file.name, dataSource);
  }

  viewer.dataSources.add(dataSource);
  return dataSource;
}

clearButton.addEventListener("click", () => {
  viewer.dataSources.removeAll();
  status.textContent = "图层已清空，请重新选择 GeoJSON 文件";
  fileInput.value = "";
});

fileInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);

  if (files.length === 0) {
    return;
  }

  viewer.dataSources.removeAll();
  status.textContent = `正在加载 ${files.length} 个文件…`;

  const loadedSources = [];
  const errors = [];

  for (const file of files) {
    try {
      loadedSources.push({
        file,
        dataSource: await loadGeoJsonFile(file),
      });
    } catch (error) {
      console.error(`加载失败：${file.name}`, error);
      errors.push(file.name);
    }
  }

  const roadEntry = loadedSources.find(({ file }) =>
    file.name.toLowerCase().includes("road_surface")
  );

  if (roadEntry) {
    await viewer.zoomTo(roadEntry.dataSource);
  } else if (loadedSources.length > 0) {
    await viewer.zoomTo(loadedSources[0].dataSource);
  }

  status.textContent = errors.length === 0
    ? `已加载 ${loadedSources.length}/${files.length} 个 GeoJSON`
    : `已加载 ${loadedSources.length}/${files.length} 个；失败：${errors.join(", ")}`;
});
