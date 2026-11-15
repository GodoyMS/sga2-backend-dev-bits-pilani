export const VEHICLE_STATUSES = ['active', 'idle', 'maintenance', 'out_of_service', 'offline'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export interface VehicleRow {
  id: string;
  plate_number: string;
  make: string | null;
  model: string | null;
  year: number | null;
  vehicle_type: string;
  status: VehicleStatus;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  location_source: string | null;
  location_updated_at: Date | null;
  assigned_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const toVehicle = (v: VehicleRow) => ({
  id: v.id,
  plateNumber: v.plate_number,
  make: v.make,
  model: v.model,
  year: v.year,
  vehicleType: v.vehicle_type,
  status: v.status,
  address: v.address,
  location:
    v.latitude === null || v.longitude === null
      ? null
      : {
          latitude: Number(v.latitude),
          longitude: Number(v.longitude),
          source: v.location_source,
          updatedAt: v.location_updated_at,
        },
  assignedUserId: v.assigned_user_id,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
});
