-- Free statement imports are counted per device per month (DeviceCheck), not once ever.
ALTER TABLE sessions ADD COLUMN device_count INTEGER;
