declare module "tz-lookup" {
	/** Returns the IANA timezone name for the given lat/lon. */
	function tzLookup(lat: number, lon: number): string;
	export = tzLookup;
}
